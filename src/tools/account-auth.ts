/**
 * Lote account-auth: autenticação, configurações da conta e metadados de campos.
 *
 * - check_api_access: diagnóstico de acesso (credencial, projeto Cloud, 2SV, MCC).
 * - get_account_settings / update_account_settings: auto-tagging, tracking
 *   template, sufixo de URL final, relatório de chamadas, nome, conversões e
 *   optimization score — de uma conta ou do MCC inteiro.
 * - get_identity_verification / start_identity_verification: verificação de
 *   identidade do anunciante (prazos e link de ação).
 * - get_gaql_fields / validate_gaql: metadados reais dos campos GAQL
 *   (GoogleAdsFieldService), para o agente montar e conferir queries.
 *
 * Tools de leitura chamam checkCustomerAccess (o teste de allowlist confere no fonte).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  checkCustomerAccess,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Constantes ─────────────────────────────────────────────────────────

/** Significado de cada status de conta (enums/customer_status.proto, v25). */
export const CUSTOMER_STATUS_NOTES: Record<string, string> = {
  CANCELED: "Conta CANCELADA: não veicula anúncios; um usuário administrador pode reativá-la.",
  SUSPENDED: "Conta SUSPENSA: não veicula anúncios e só o suporte do Google reativa (em geral pagamento ou política).",
  CLOSED: "Conta ENCERRADA: não veicula anúncios e o status é permanente (contas de teste também aparecem como CLOSED).",
};

/** Configurações de conta lidas de customer (v25). Todos os campos são selecionáveis em FROM customer. */
export const ACCOUNT_SETTINGS_QUERY = `
  SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone,
         customer.status, customer.manager, customer.test_account,
         customer.auto_tagging_enabled, customer.tracking_url_template, customer.final_url_suffix,
         customer.call_reporting_setting.call_reporting_enabled,
         customer.call_reporting_setting.call_conversion_reporting_enabled,
         customer.call_reporting_setting.call_conversion_action,
         customer.conversion_tracking_setting.conversion_tracking_status,
         customer.conversion_tracking_setting.conversion_tracking_id,
         customer.conversion_tracking_setting.cross_account_conversion_tracking_id,
         customer.conversion_tracking_setting.accepted_customer_data_terms,
         customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
         customer.conversion_tracking_setting.google_ads_conversion_customer,
         customer.optimization_score, customer.optimization_score_weight
  FROM customer
  LIMIT 1`;

/**
 * Campanhas que ainda carregam manual_cpc.enhanced_cpc_enabled=true. O ECPC não
 * existe mais em Pesquisa e Display (semana de 31/03/2025 — elas passaram a
 * funcionar como CPC manual) e o Google ignora o flag em Shopping.
 */
export const LEGACY_ECPC_QUERY = `
  SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
         campaign.bidding_strategy_type, campaign.manual_cpc.enhanced_cpc_enabled
  FROM campaign
  WHERE campaign.manual_cpc.enhanced_cpc_enabled = true
    AND campaign.status != 'REMOVED'`;

/**
 * Tags ValueTrack que inserem a URL final. Template de conta/campanha/grupo sem
 * uma delas quebra a landing page (Central de Ajuda do Google Ads, "Set up
 * tracking with ValueTrack parameters").
 */
const LPURL_TAG = /\{(?:lpurl(?:\+[23])?|unescapedlpurl|escapedlpurl|unescapedurl)\}/i;

const DEFAULT_MIN_OPTIMIZATION_SCORE = 0.7;
const DEFAULT_MAX_ACCOUNTS = 100;
const MAX_ACCOUNTS_LIMIT = 500;

/** A API pede cache e polling espaçado para GetIdentityVerification (rate-limited). */
const IDENTITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Metadados de campo só mudam com a versão da API: cache longo no processo. */
const FIELD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const CORE_DATE_SEGMENTS = new Set(["date", "week", "month", "quarter", "year"]);
const FIELD_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

// ── Helpers ────────────────────────────────────────────────────────────

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errorCodes = (err: unknown): string[] => ((err as { codes?: unknown }).codes as string[] | undefined) ?? [];

/** customerId só com dígitos (hífens aceitos e removidos); null se inválido. */
function normalizeCid(customerId: string): string | null {
  const cid = customerId.trim().replace(/-/g, "");
  return /^\d+$/.test(cid) ? cid : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function capAccounts(value: number | undefined): number {
  const n = value ?? DEFAULT_MAX_ACCOUNTS;
  if (!Number.isInteger(n) || n < 1) throw new Error(`maxAccounts inválido: ${value}. Use um inteiro positivo.`);
  return Math.min(n, MAX_ACCOUNTS_LIMIT);
}

interface ScopedAccount {
  id: string;
  name: string;
  status: string;
}

/**
 * Contas-cliente (não-gerente) do MCC do login, de todos os níveis, já filtradas
 * pela allowlist — a mesma regra de list_accounts: num serviço hospedado, conta
 * fora da allowlist não aparece nem é consultada.
 */
async function scopedClientAccounts(
  ctx: ToolContext,
  client: GoogleAdsClient,
  statuses: string[]
): Promise<ScopedAccount[]> {
  const rows = await client.listChildAccounts(undefined, { allStatuses: true });
  const seen = new Set<string>();
  const accounts: ScopedAccount[] = [];
  for (const row of rows) {
    const c = (row.customerClient ?? {}) as Row;
    const id = String(c.id ?? "");
    const status = String(c.status ?? "UNSPECIFIED");
    if (!id || seen.has(id) || c.manager === true || !statuses.includes(status)) continue;
    if (checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted) !== null) continue;
    seen.add(id);
    accounts.push({ id, name: String(c.descriptiveName ?? ""), status });
  }
  return accounts;
}

// ── Configurações da conta ─────────────────────────────────────────────

interface AccountSettings {
  customer_id: string;
  nome: string | null;
  status: string | null;
  gerente: boolean;
  conta_teste: boolean;
  moeda: string | null;
  fuso: string | null;
  auto_tagging: boolean | null;
  tracking_url_template: string | null;
  final_url_suffix: string | null;
  call_reporting: {
    ativado: boolean | null;
    conversao_de_chamada: boolean | null;
    acao_de_conversao: string | null;
  };
  conversion_tracking: {
    status: string;
    conversion_tracking_id: string | null;
    cross_account_conversion_tracking_id: string | null;
    termos_dados_cliente_aceitos: boolean;
    enhanced_conversions_for_leads: boolean;
    conta_de_conversao: string | null;
  };
  optimization_score_pct: number | null;
  optimization_score_weight: number;
}

/* No JSON da API, campo não-optional com valor padrão (bool false, enum 0,
   double 0) é omitido: ausente = false/0/UNSPECIFIED. Campo `optional` ausente
   é "não definido" e vira null aqui. */
function shapeSettings(row: Row): AccountSettings {
  const c = (row.customer ?? {}) as Row;
  const call = (c.callReportingSetting ?? {}) as Row;
  const conv = (c.conversionTrackingSetting ?? {}) as Row;
  const optional = <T>(value: unknown) => (value === undefined ? null : (value as T));
  const score = c.optimizationScore;
  return {
    customer_id: String(c.id ?? ""),
    nome: optional<string>(c.descriptiveName),
    status: optional<string>(c.status),
    gerente: c.manager === true,
    conta_teste: c.testAccount === true,
    moeda: optional<string>(c.currencyCode),
    fuso: optional<string>(c.timeZone),
    auto_tagging: optional<boolean>(c.autoTaggingEnabled),
    tracking_url_template: optional<string>(c.trackingUrlTemplate),
    final_url_suffix: optional<string>(c.finalUrlSuffix),
    call_reporting: {
      ativado: optional<boolean>(call.callReportingEnabled),
      conversao_de_chamada: optional<boolean>(call.callConversionReportingEnabled),
      acao_de_conversao: optional<string>(call.callConversionAction),
    },
    conversion_tracking: {
      status: String(conv.conversionTrackingStatus ?? "UNSPECIFIED"),
      conversion_tracking_id: optional<string>(conv.conversionTrackingId),
      cross_account_conversion_tracking_id: optional<string>(conv.crossAccountConversionTrackingId),
      termos_dados_cliente_aceitos: conv.acceptedCustomerDataTerms === true,
      enhanced_conversions_for_leads: conv.enhancedConversionsForLeadsEnabled === true,
      conta_de_conversao: optional<string>(conv.googleAdsConversionCustomer) || null,
    },
    optimization_score_pct: score === undefined || score === null ? null : Math.round(Number(score) * 1000) / 10,
    optimization_score_weight: Number(c.optimizationScoreWeight ?? 0),
  };
}

type Severity = "alta" | "media" | "info";
interface Flag {
  severidade: Severity;
  alerta: string;
}

function settingsFlags(s: AccountSettings, minScore: number): Flag[] {
  const flags: Flag[] = [];
  if (s.status && CUSTOMER_STATUS_NOTES[s.status]) flags.push({ severidade: "alta", alerta: CUSTOMER_STATUS_NOTES[s.status] });
  if (s.tracking_url_template && !LPURL_TAG.test(s.tracking_url_template)) {
    flags.push({
      severidade: "alta",
      alerta: "Tracking template da conta sem {lpurl} (ou variante): sem a tag que insere a URL final, a landing page quebra.",
    });
  }
  if (!s.gerente) {
    if (s.auto_tagging === false) {
      flags.push({
        severidade: "alta",
        alerta: "Auto-tagging DESLIGADO: o GCLID não vai na URL — quebra a importação de conversões do GA4 e o upload de " +
          "conversões offline por GCLID. Ligue com update_account_settings (autoTaggingEnabled=true).",
      });
    } else if (s.auto_tagging === null) {
      flags.push({ severidade: "info", alerta: "A API não devolveu auto_tagging_enabled para esta conta." });
    }
    if (s.conversion_tracking.status === "NOT_CONVERSION_TRACKED") {
      flags.push({
        severidade: "alta",
        alerta: "Conta sem acompanhamento de conversões (NOT_CONVERSION_TRACKED): lances por conversão ficam sem sinal.",
      });
    }
    if (s.optimization_score_pct !== null && s.optimization_score_pct < minScore * 100) {
      flags.push({
        severidade: "media",
        alerta: `Optimization score ${s.optimization_score_pct}% (abaixo de ${Math.round(minScore * 100)}%) — veja list_recommendations.`,
      });
    }
    if (!s.conversion_tracking.termos_dados_cliente_aceitos) {
      flags.push({
        severidade: "info",
        alerta: "Termos de dados do cliente não aceitos: são exigidos para conversões otimizadas (enhanced conversions) para web.",
      });
    }
  }
  if (s.conta_teste) flags.push({ severidade: "info", alerta: "Conta de TESTE: não veicula anúncios reais." });
  return flags;
}

const SEVERITY_ORDER: Record<Severity, number> = { alta: 0, media: 1, info: 2 };

async function readSettings(client: GoogleAdsClient, cid: string): Promise<AccountSettings | null> {
  const rows = await client.searchStream(cid, ACCOUNT_SETTINGS_QUERY);
  return rows[0] ? shapeSettings(rows[0]) : null;
}

/** Score ponderado do MCC: Σ(score × peso) ÷ Σ peso, só com contas pontuadas (peso > 0). */
function weightedScore(settings: AccountSettings[]): number | null {
  let weighted = 0;
  let weights = 0;
  for (const s of settings) {
    if (s.optimization_score_pct === null || s.optimization_score_weight <= 0) continue;
    weighted += s.optimization_score_pct * s.optimization_score_weight;
    weights += s.optimization_score_weight;
  }
  return weights > 0 ? Math.round((weighted / weights) * 10) / 10 : null;
}

// ── Verificação de identidade ──────────────────────────────────────────

interface VerificationView {
  programa: string;
  status: string;
  prazo_inicio: string | null;
  prazo_conclusao: string | null;
  dias_ate_prazo_conclusao: number | null;
  action_url: string | null;
  link_expira_em: string | null;
}

/* Datas vêm como "yyyy-MM-dd HH:mm:ss" sem fuso documentado: lidas como UTC. */
function parseApiDateTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function summarizeVerification(response: Row): VerificationView[] {
  const list = Array.isArray(response.identityVerification) ? (response.identityVerification as Row[]) : [];
  return list.map((item) => {
    const requirement = (item.identityVerificationRequirement ?? {}) as Row;
    const progress = (item.verificationProgress ?? {}) as Row;
    const deadline = (requirement.verificationCompletionDeadlineTime as string | undefined) || null;
    const deadlineMs = parseApiDateTime(deadline);
    return {
      programa: String(item.verificationProgram ?? "UNSPECIFIED"),
      status: String(progress.programStatus ?? "UNSPECIFIED"),
      prazo_inicio: (requirement.verificationStartDeadlineTime as string | undefined) || null,
      prazo_conclusao: deadline,
      dias_ate_prazo_conclusao: deadlineMs === null ? null : Math.floor((deadlineMs - Date.now()) / 86_400_000),
      action_url: (progress.actionUrl as string | undefined) || null,
      link_expira_em: (progress.invitationLinkExpirationTime as string | undefined) || null,
    };
  });
}

const identityCache = new Map<string, { at: number; response: Row }>();

async function fetchIdentityVerification(
  client: GoogleAdsClient,
  cid: string,
  refresh: boolean
): Promise<{ response: Row; cachedAt: number; fromCache: boolean }> {
  const cached = identityCache.get(cid);
  if (!refresh && cached && Date.now() - cached.at < IDENTITY_CACHE_TTL_MS) {
    return { response: cached.response, cachedAt: cached.at, fromCache: true };
  }
  const response = (await client.getIdentityVerification(cid)) ?? {};
  const at = Date.now();
  identityCache.set(cid, { at, response });
  return { response, cachedAt: at, fromCache: false };
}

const ACTIONABLE_STATUSES = new Set(["PENDING_USER_ACTION", "FAILURE"]);

function describeVerification(views: VerificationView[]): string {
  if (views.length === 0) return "não exigida (a API não lista verificação para esta conta)";
  return views
    .map((v) => {
      const deadline = v.prazo_conclusao ? ` — prazo ${v.prazo_conclusao}${v.dias_ate_prazo_conclusao !== null ? ` (${v.dias_ate_prazo_conclusao} dia(s))` : ""}` : "";
      return `${v.status}${deadline}`;
    })
    .join("; ");
}

// ── Metadados GAQL (GoogleAdsFieldService) ─────────────────────────────

interface FieldMeta {
  name: string;
  category: string;
  selectable: boolean;
  filterable: boolean;
  sortable: boolean;
  dataType: string | null;
  isRepeated: boolean;
  enumValues: string[];
  selectableWith: string[];
  attributeResources: string[];
  metrics: string[];
  segments: string[];
}

function toFieldMeta(raw: Row): FieldMeta {
  const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : []);
  return {
    name: String(raw.name ?? ""),
    category: String(raw.category ?? "UNSPECIFIED"),
    selectable: raw.selectable === true,
    filterable: raw.filterable === true,
    sortable: raw.sortable === true,
    dataType: (raw.dataType as string | undefined) ?? null,
    isRepeated: raw.isRepeated === true,
    enumValues: list(raw.enumValues),
    selectableWith: list(raw.selectableWith),
    attributeResources: list(raw.attributeResources),
    metrics: list(raw.metrics),
    segments: list(raw.segments),
  };
}

const fieldCache = new Map<string, { at: number; value: Promise<FieldMeta> }>();
const prefixCache = new Map<string, { at: number; value: Promise<FieldMeta[]> }>();

function cached<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FIELD_CACHE_TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // Erro não fica em cache: a próxima chamada tenta de novo.
  value.catch(() => cache.delete(key));
  return value;
}

function fieldMeta(client: GoogleAdsClient, name: string): Promise<FieldMeta> {
  return cached(fieldCache, name, async () => toFieldMeta(await client.getGoogleAdsField(name)));
}

/** Todos os artefatos cujo nome começa com "<prefix>." (atributos de um recurso, segments, metrics). */
function fieldsUnder(client: GoogleAdsClient, prefix: string): Promise<FieldMeta[]> {
  return cached(prefixCache, prefix, async () => {
    const rows = await client.searchGoogleAdsFields(
      `SELECT name, category, selectable, filterable, sortable, data_type, is_repeated, enum_values WHERE name LIKE '${prefix}.%'`
    );
    // LIKE trata "_" como curinga: o filtro exato de prefixo é aqui.
    return (Array.isArray(rows) ? rows : []).map(toFieldMeta).filter((f) => f.name.startsWith(`${prefix}.`));
  });
}

/** Limpa os caches do módulo (testes). */
export function resetAccountAuthCaches(): void {
  identityCache.clear();
  fieldCache.clear();
  prefixCache.clear();
}

interface ParsedGaql {
  select: string[];
  from: string;
  where: string[];
  orderBy: string[];
  limit: string | null;
}

const FIELD_TOKEN = /\b([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)+)\b/g;

/** Literal de string GAQL (aspas simples ou duplas, com escapes). */
const STRING_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

/**
 * Separa as cláusulas de uma query GAQL. As palavras-chave (FROM, WHERE, ORDER BY,
 * LIMIT, PARAMETERS) são procuradas numa cópia em que cada literal de string virou
 * espaços do mesmo tamanho — assim `campaign.name = 'Limit Offer'` não abre uma
 * cláusula LIMIT nem corta o WHERE — e as posições valem para a query original.
 */
export function parseGaqlClauses(query: string): ParsedGaql {
  const q = query.replace(/\s+/g, " ").trim();
  const masked = q.replace(STRING_LITERAL, (literal) => " ".repeat(literal.length));
  if (/['"]/.test(masked)) throw new Error("literal de string sem aspas de fechamento");
  const upper = masked.toUpperCase();
  const at = (keyword: string) => {
    const match = new RegExp(`\\b${keyword}\\b`).exec(upper);
    return match ? match.index : -1;
  };
  const selectAt = at("SELECT");
  const fromAt = at("FROM");
  if (selectAt !== 0) throw new Error("a query precisa começar com SELECT");
  if (fromAt < 0) throw new Error("falta a cláusula FROM");
  const fieldsIn = (start: number, end: number) => [...masked.slice(start, end).matchAll(FIELD_TOKEN)].map((m) => m[1]);
  const whereAt = at("WHERE");
  const orderAt = at("ORDER BY");
  const limitAt = at("LIMIT");
  const paramsAt = at("PARAMETERS");
  const endOf = (start: number, candidates: number[]) => {
    const after = candidates.filter((i) => i > start);
    return after.length ? Math.min(...after) : q.length;
  };
  const fromEnd = endOf(fromAt, [whereAt, orderAt, limitAt, paramsAt]);
  /* LIMIT é a última cláusula (só PARAMETERS pode vir depois): o valor é tudo até
     PARAMETERS ou o fim — "LIMIT 10 20" ou "LIMIT 10 ORDER BY x" viram erro. */
  const limit = limitAt > fromAt ? q.slice(limitAt + 5, endOf(limitAt, [paramsAt])).trim() : null;
  return {
    select: q.slice(6, fromAt).split(",").map((f) => f.trim()).filter(Boolean),
    from: q.slice(fromAt + 4, fromEnd).trim(),
    where: whereAt > fromAt ? fieldsIn(whereAt + 5, endOf(whereAt, [orderAt, limitAt, paramsAt])) : [],
    orderBy: orderAt > fromAt ? fieldsIn(orderAt + 8, endOf(orderAt, [limitAt, paramsAt])) : [],
    limit,
  };
}

/** Distância de edição (para sugerir o nome certo de um campo inexistente). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function suggest(name: string, candidates: string[]): string[] {
  const leaf = name.split(".").slice(1).join(".");
  return candidates
    .map((candidate) => ({ candidate, score: editDistance(leaf, candidate.split(".").slice(1).join(".")) }))
    .filter((c) => c.score <= Math.max(2, Math.floor(leaf.length / 3)) || c.candidate.includes(leaf))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => c.candidate);
}

/**
 * Confere a query com os metadados reais da API (as mesmas regras do validador
 * dos testes): campo existe; prefixo é o FROM, um recurso atribuído ou de
 * segmentação dele, ou segmento/métrica compatível; SELECT selecionável, WHERE
 * filtrável, ORDER BY ordenável; segmento (exceto datas) e campo de recurso de
 * segmentação no WHERE precisam estar no SELECT; data no SELECT exige data no WHERE.
 */
async function validateGaqlLive(client: GoogleAdsClient, query: string): Promise<{ from: string; errors: string[]; checked: number }> {
  let parsed: ParsedGaql;
  try {
    parsed = parseGaqlClauses(query);
  } catch (err) {
    return { from: "", errors: [errorMessage(err)], checked: 0 };
  }
  const errors: string[] = [];
  if (!FIELD_NAME.test(parsed.from) || parsed.from.includes(".")) {
    return { from: parsed.from, errors: [`FROM "${parsed.from}": nome de recurso inválido`], checked: 0 };
  }
  let resource: FieldMeta;
  try {
    resource = await fieldMeta(client, parsed.from);
  } catch (err) {
    return { from: parsed.from, errors: [`FROM ${parsed.from}: recurso não encontrado na API (${errorMessage(err).split("\n")[0]})`], checked: 0 };
  }
  if (resource.category !== "RESOURCE") {
    return { from: parsed.from, errors: [`FROM ${parsed.from}: não é um recurso (categoria ${resource.category})`], checked: 0 };
  }
  if (parsed.limit !== null && !/^[1-9]\d*$/.test(parsed.limit)) {
    errors.push(`LIMIT ${parsed.limit || "(sem valor)"}: use um inteiro positivo (LIMIT é a última cláusula; só PARAMETERS vem depois)`);
  }

  const segmentingResources = new Set(resource.segments.filter((s) => !s.startsWith("segments.")));
  const compatibleSegments = new Set(resource.segments.filter((s) => s.startsWith("segments.")));
  const compatibleMetrics = new Set(resource.metrics);
  const allowedPrefixes = new Set([parsed.from, ...resource.attributeResources, ...segmentingResources]);
  const selected = new Set(parsed.select);

  const invalidSelect = parsed.select.filter((f) => !FIELD_NAME.test(f) || !f.includes("."));
  for (const f of invalidSelect) errors.push(`SELECT: "${f}" não é um nome de campo (use recurso.campo)`);

  const all = [
    ...parsed.select.filter((f) => !invalidSelect.includes(f)).map((field) => ({ field, clause: "SELECT" as const })),
    ...parsed.where.map((field) => ({ field, clause: "WHERE" as const })),
    ...parsed.orderBy.map((field) => ({ field, clause: "ORDER BY" as const })),
  ];
  const prefixes = [...new Set(all.map(({ field }) => field.split(".")[0]))];
  const known = new Map<string, FieldMeta[]>();
  await Promise.all(
    prefixes
      .filter((prefix) => prefix === "segments" || prefix === "metrics" || allowedPrefixes.has(prefix))
      .map(async (prefix) => known.set(prefix, await fieldsUnder(client, prefix)))
  );

  for (const { field, clause } of all) {
    const prefix = field.split(".")[0];
    if (prefix === "segments" && !compatibleSegments.has(field)) {
      errors.push(`${clause}: ${field} não é segmento compatível com FROM ${parsed.from}`);
      continue;
    }
    if (prefix === "metrics" && !compatibleMetrics.has(field)) {
      errors.push(`${clause}: ${field} não é métrica compatível com FROM ${parsed.from}`);
      continue;
    }
    if (prefix !== "segments" && prefix !== "metrics" && !allowedPrefixes.has(prefix)) {
      errors.push(`${clause}: ${field} — ${prefix} não é atribuído nem de segmentação para FROM ${parsed.from}`);
      continue;
    }
    const candidates = known.get(prefix) ?? [];
    const meta = candidates.find((f) => f.name === field);
    if (!meta) {
      const hints = suggest(field, candidates.map((f) => f.name));
      errors.push(`${clause}: campo ${field} não existe${hints.length ? ` (quis dizer ${hints.join(", ")}?)` : ""}`);
      continue;
    }
    if (clause === "SELECT" && !meta.selectable) errors.push(`SELECT: ${field} não é selecionável`);
    if (clause === "WHERE" && !meta.filterable) errors.push(`WHERE: ${field} não é filtrável`);
    if (clause === "ORDER BY" && !meta.sortable) errors.push(`ORDER BY: ${field} não é ordenável`);
    if (clause === "WHERE") {
      const name = field.split(".").slice(1).join(".");
      const mustBeSelected = segmentingResources.has(prefix) || (prefix === "segments" && !CORE_DATE_SEGMENTS.has(name));
      if (mustBeSelected && !selected.has(field)) {
        errors.push(`WHERE: ${field} precisa estar no SELECT (${prefix === "segments" ? "segmento" : "recurso de segmentação"} de FROM ${parsed.from})`);
      }
    }
  }
  const dateInSelect = parsed.select.some((f) => f.startsWith("segments.") && CORE_DATE_SEGMENTS.has(f.slice(9)));
  const dateInWhere = parsed.where.some((f) => f.startsWith("segments.") && CORE_DATE_SEGMENTS.has(f.slice(9)));
  if (dateInSelect && !dateInWhere) {
    errors.push("WHERE: segmento de data (date/week/month/quarter/year) no SELECT exige um período finito no WHERE (ex.: segments.date DURING LAST_30_DAYS)");
  }
  return { from: parsed.from, errors: [...new Set(errors)], checked: all.length };
}

function fieldView(meta: FieldMeta, withSelectableWith: boolean): Row {
  return {
    name: meta.name,
    category: meta.category,
    selectable: meta.selectable,
    filterable: meta.filterable,
    sortable: meta.sortable,
    data_type: meta.dataType,
    is_repeated: meta.isRepeated,
    ...(meta.enumValues.length ? { enum_values: meta.enumValues } : {}),
    ...(withSelectableWith
      ? { selectable_with: meta.selectableWith }
      : meta.selectableWith.length
        ? { selectable_with_total: meta.selectableWith.length }
        : {}),
  };
}

// ── Registro ───────────────────────────────────────────────────────────

export function registerAccountAuthTools(ctx: ToolContext): void {

  // ── Diagnóstico de acesso ──────────────────────────────────────────

  ctx.mcp.registerTool(
    "check_api_access",
    {
      description: [
        "Diagnóstico de acesso à Google Ads API. READ OPERATION — não altera nada.",
        "Mostra como o servidor se autentica (OAuth de usuário ou service account), se há developer token",
        "(opcional e ignorado pela API desde 09/09/2026 — o nível de acesso é do projeto Google Cloud),",
        "o MCC do login-customer-id (só quando ele está na allowlist), as contas acessíveis e, com customerId,",
        "testa uma consulta na conta.",
        "Erros vêm explicados: projeto Cloud só com acesso Test (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION),",
        "2SV ausente (TWO_STEP_VERIFICATION_NOT_ENROLLED), usuário sem acesso, login-customer-id errado, cota.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Conta para testar de ponta a ponta (opcional)."),
      },
    },
    async ({ customerId }) => {
      let cid: string | null = null;
      if (customerId !== undefined) {
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        cid = normalizeCid(customerId);
        if (!cid) return fail(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`);
      }
      let client: GoogleAdsClient;
      try {
        client = ctx.getClient();
      } catch (err) {
        return fail(`Configuração inválida — o servidor não consegue montar a credencial: ${errorMessage(err)}`);
      }

      const problems: string[] = [];
      /* O MCC do login também passa pela allowlist: um tenant limitado a um cliente
         não vê o ID nem o status do MCC da agência, e o MCC não é consultado. */
      const loginAllowed = checkCustomerAccess(client.loginCustomer, ctx.allowedCustomerIds, ctx.hosted) === null;
      const loginLabel = loginAllowed ? `MCC ${client.loginCustomer}` : "MCC do login";
      const configuracao = {
        versao_api: client.apiVersion,
        autenticacao:
          client.authMode === "service_account"
            ? `service account (${client.serviceAccountEmail}) — adicione este e-mail como usuário da conta/MCC no Google Ads`
            : "OAuth de usuário (refresh token) — desde 21/04/2026 a conta Google precisa ter verificação em duas etapas",
        developer_token: client.hasDeveloperToken
          ? "definido — opcional e ignorado pela API desde 09/09/2026 (pode remover GOOGLE_ADS_DEVELOPER_TOKEN)"
          : "não definido (ok: opcional desde 09/09/2026; o acesso vem do projeto Google Cloud do OAuth client)",
        ...(loginAllowed ? { login_customer_id: client.loginCustomer } : {}),
        modo: client.isReadOnly ? "somente leitura" : client.isDryRun ? "dry-run (validateOnly, nada é gravado)" : "leitura e escrita",
      };

      const probe = async (target: string, fields: string) => {
        try {
          const rows = await client.searchStream(target, `SELECT ${fields} FROM customer LIMIT 1`);
          const c = ((rows[0] ?? {}).customer ?? {}) as Row;
          return { ok: true as const, customer: c };
        } catch (err) {
          problems.push(errorMessage(err));
          return { ok: false as const, erro: errorMessage(err), codigos: errorCodes(err) };
        }
      };

      let contasAcessiveis: Row;
      try {
        const ids = (await client.listAccessibleCustomers()).map((id) => String(id).replace(/-/g, ""));
        const visible = ids.filter((id) => checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted) === null);
        contasAcessiveis = {
          ok: true,
          ...(ctx.hosted ? {} : { total: ids.length }),
          ids_liberados: visible.slice(0, 50),
          login_customer_id_acessivel: ids.includes(client.loginCustomer),
        };
        if (!ids.includes(client.loginCustomer)) {
          problems.push(
            `O usuário/service account não tem acesso direto ao ${loginLabel} (GOOGLE_ADS_LOGIN_CUSTOMER_ID): ` +
              "adicione-o como usuário desse MCC ou corrija a variável."
          );
        }
      } catch (err) {
        problems.push(errorMessage(err));
        contasAcessiveis = { ok: false, erro: errorMessage(err), codigos: errorCodes(err) };
      }

      let mcc: Row;
      if (!loginAllowed) {
        mcc = {
          verificado: false,
          motivo: "o MCC do login (GOOGLE_ADS_LOGIN_CUSTOMER_ID) está fora da allowlist deste servidor (ALLOWED_CUSTOMER_IDS): não é consultado nem exibido",
        };
      } else {
        const loginProbe = await probe(client.loginCustomer, "customer.id, customer.manager, customer.test_account, customer.status");
        mcc = loginProbe.ok
          ? {
              ok: true,
              gerente: loginProbe.customer.manager === true,
              conta_teste: loginProbe.customer.testAccount === true,
              status: loginProbe.customer.status ?? null,
            }
          : loginProbe;
        if (loginProbe.ok && loginProbe.customer.manager !== true) {
          problems.push(`GOOGLE_ADS_LOGIN_CUSTOMER_ID ${client.loginCustomer} não é uma conta gerente (MCC).`);
        }
        const mccStatus = loginProbe.ok ? String(loginProbe.customer.status ?? "") : "";
        if (loginProbe.ok && mccStatus !== "ENABLED") {
          problems.push(
            `${loginLabel} (GOOGLE_ADS_LOGIN_CUSTOMER_ID) com status ${mccStatus || "desconhecido"}, não ENABLED` +
              (CUSTOMER_STATUS_NOTES[mccStatus] ? ` — ${CUSTOMER_STATUS_NOTES[mccStatus]}` : "") +
              " Chamadas pelas contas-cliente via esse MCC podem falhar."
          );
        }
      }

      let conta: Row | undefined;
      if (cid) {
        const result = await probe(
          cid,
          "customer.id, customer.descriptive_name, customer.status, customer.manager, customer.test_account, customer.currency_code"
        );
        conta = result.ok
          ? {
              ok: true,
              customer_id: cid,
              nome: result.customer.descriptiveName ?? null,
              status: result.customer.status ?? null,
              conta_teste: result.customer.testAccount === true,
              moeda: result.customer.currencyCode ?? null,
              ...(CUSTOMER_STATUS_NOTES[String(result.customer.status)] ? { nota: CUSTOMER_STATUS_NOTES[String(result.customer.status)] } : {}),
            }
          : { customer_id: cid, ...result };
      }

      const resumo = problems.length === 0 ? "Acesso OK." : `${problems.length} problema(s) encontrado(s) — veja "problemas".`;
      return {
        content: [
          text(
            `${resumo}\n\n${formatJson({
              configuracao,
              contas_acessiveis: contasAcessiveis,
              mcc_do_login: mcc,
              ...(conta ? { conta } : {}),
              problemas: problems,
            })}`
          ),
        ],
      };
    }
  );

  // ── Configurações da conta ─────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_account_settings",
    {
      description: [
        "Configurações de conta: auto-tagging, tracking template, sufixo de URL final, relatório de chamadas,",
        "acompanhamento de conversões (status, termos de dados do cliente), optimization score e status.",
        "READ OPERATION — não altera nada.",
        "",
        "Alerta: auto-tagging desligado (quebra GA4 e conversões offline por GCLID), NOT_CONVERSION_TRACKED,",
        "tracking template sem {lpurl}, optimization score baixo, conta SUSPENSA/CANCELADA/ENCERRADA e",
        "campanhas que ainda têm Enhanced CPC ligado (ECPC não existe mais em Pesquisa/Display).",
        "allAccounts=true varre as contas-cliente do MCC do login e calcula o optimization score ponderado do MCC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Customer ID (use este OU allAccounts)."),
        allAccounts: z.boolean().optional().describe("Varre todas as contas-cliente do MCC do login (filtradas pela allowlist)."),
        minOptimizationScore: z.number().optional().describe("Abaixo disso o score vira alerta (0 a 1, ou 0 a 100 em %). Default: 0.7."),
        includeCampaignChecks: z.boolean().optional().describe(
          "Procura campanhas com Enhanced CPC ainda ligado. Default: true para uma conta, false em allAccounts."
        ),
        maxAccounts: z.number().optional().describe("allAccounts: máximo de contas consultadas. Default: 100 (máx. 500)."),
        format: formatSchema,
      },
    },
    async ({ customerId, allAccounts, minOptimizationScore, includeCampaignChecks, maxAccounts, format }) => {
      if (Boolean(customerId) === Boolean(allAccounts)) {
        return fail("Informe customerId OU allAccounts=true (um dos dois).");
      }
      // Aceita fração (0.7) ou porcentagem (70).
      const rawScore = minOptimizationScore ?? DEFAULT_MIN_OPTIMIZATION_SCORE;
      const minScore = rawScore > 1 && rawScore <= 100 ? rawScore / 100 : rawScore;
      if (!(minScore >= 0 && minScore <= 1)) {
        return fail(`minOptimizationScore precisa estar entre 0 e 1 (ou 0 e 100 em %) — recebido ${minOptimizationScore}.`);
      }

      if (customerId) {
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const cid = normalizeCid(customerId);
        if (!cid) return fail(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`);
        const client = ctx.getClient();
        const settings = await readSettings(client, cid);
        if (!settings) return fail(`A API não devolveu dados da conta ${cid} — confira o customerId e o acesso (check_api_access).`);
        const flags = settingsFlags(settings, minScore);
        let campanhasEcpc: Row[] = [];
        if (includeCampaignChecks !== false && !settings.gerente) {
          const rows = await client.searchStream(cid, LEGACY_ECPC_QUERY);
          campanhasEcpc = rows.map((r) => {
            const c = (r.campaign ?? {}) as Row;
            return { id: c.id, nome: c.name, status: c.status, canal: c.advertisingChannelType, estrategia: c.biddingStrategyType };
          });
          if (campanhasEcpc.length) {
            flags.push({
              severidade: "media",
              alerta: `${campanhasEcpc.length} campanha(s) ainda com manual_cpc.enhanced_cpc_enabled=true: o ECPC não existe mais em ` +
                "Pesquisa/Display desde a semana de 31/03/2025 (funcionam como CPC manual) e é ignorado em Shopping. " +
                "Avalie Maximizar conversões (tCPA opcional) ou Maximizar valor de conversão (tROAS opcional).",
            });
          }
        }
        flags.sort((a, b) => SEVERITY_ORDER[a.severidade] - SEVERITY_ORDER[b.severidade]);
        if (format === "table" || format === "csv") {
          const row = { ...settings, alertas: flags.map((f) => `${f.severidade}: ${f.alerta}`).join(" | ") };
          return { content: [text(format === "table" ? formatAsTable([row]) : formatAsCsv([row]))] };
        }
        const header = flags.length
          ? `${flags.filter((f) => f.severidade === "alta").length} alerta(s) de severidade alta, ${flags.length} no total.`
          : "Nenhum alerta.";
        return {
          content: [text(`${header}\n\n${formatJson({ conta: settings, alertas: flags, ...(campanhasEcpc.length ? { campanhas_com_ecpc: campanhasEcpc } : {}) })}`)],
        };
      }

      // allAccounts
      const cap = capAccounts(maxAccounts);
      const client = ctx.getClient();
      const accounts = await scopedClientAccounts(ctx, client, ["ENABLED", "SUSPENDED", "CANCELED", "CLOSED"]);
      const porStatus: Record<string, number> = {};
      for (const a of accounts) porStatus[a.status] = (porStatus[a.status] ?? 0) + 1;
      const enabled = accounts.filter((a) => a.status === "ENABLED");
      const toQuery = enabled.slice(0, cap);
      const results = await mapLimit(toQuery, 4, async (account) => {
        try {
          const settings = await readSettings(client, account.id);
          if (!settings) return { account, erro: "a API não devolveu dados" };
          const flags = settingsFlags(settings, minScore);
          if (includeCampaignChecks === true) {
            const rows = await client.searchStream(account.id, LEGACY_ECPC_QUERY);
            if (rows.length) {
              flags.push({ severidade: "media", alerta: `${rows.length} campanha(s) com Enhanced CPC ainda ligado (ECPC descontinuado).` });
            }
          }
          return { account, settings, flags };
        } catch (err) {
          return { account, erro: errorMessage(err) };
        }
      });
      const inactive = accounts
        .filter((a) => a.status !== "ENABLED")
        .map((a) => ({
          customer_id: a.id,
          nome: a.name,
          status: a.status,
          alertas: [`alta: ${CUSTOMER_STATUS_NOTES[a.status] ?? `status ${a.status}`}`],
        }));
      const rows = [
        ...results.map((r) =>
          "settings" in r && r.settings
            ? {
                customer_id: r.account.id,
                nome: r.settings.nome ?? r.account.name,
                status: r.settings.status,
                auto_tagging: r.settings.auto_tagging,
                conversion_tracking: r.settings.conversion_tracking.status,
                optimization_score_pct: r.settings.optimization_score_pct,
                tracking_url_template: r.settings.tracking_url_template,
                final_url_suffix: r.settings.final_url_suffix,
                alertas: (r.flags ?? [])
                  .sort((a, b) => SEVERITY_ORDER[a.severidade] - SEVERITY_ORDER[b.severidade])
                  .map((f) => `${f.severidade}: ${f.alerta}`),
              }
            : { customer_id: r.account.id, nome: r.account.name, status: r.account.status, erro: (r as { erro?: string }).erro, alertas: [] as string[] }
        ),
        ...inactive,
      ];
      const highCount = (row: { alertas: string[] }) => row.alertas.filter((a) => a.startsWith("alta")).length;
      rows.sort((a, b) => highCount(b) - highCount(a) || b.alertas.length - a.alertas.length);
      const scored = results.flatMap((r) => ("settings" in r && r.settings ? [r.settings] : []));
      const resumo = {
        contas_no_escopo: accounts.length,
        por_status: porStatus,
        contas_ativas_consultadas: toQuery.length,
        ...(enabled.length > toQuery.length ? { contas_ativas_nao_consultadas: enabled.length - toQuery.length } : {}),
        auto_tagging_desligado: scored.filter((s) => s.auto_tagging === false).length,
        sem_acompanhamento_de_conversao: scored.filter((s) => s.conversion_tracking.status === "NOT_CONVERSION_TRACKED").length,
        score_abaixo_do_minimo: scored.filter((s) => s.optimization_score_pct !== null && s.optimization_score_pct < minScore * 100).length,
        optimization_score_ponderado_pct: weightedScore(scored),
        erros: results.filter((r) => "erro" in r && r.erro).length,
      };
      if (format === "table" || format === "csv") {
        const flat = rows.map((r) => ({ ...r, alertas: r.alertas.join(" | ") }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      return {
        content: [
          text(
            `${accounts.length} conta(s) no escopo; ${rows.filter((r) => highCount(r) > 0).length} com alerta de severidade alta.\n` +
              "optimization_score_ponderado_pct = Σ(score × optimization_score_weight) ÷ Σ peso das contas pontuadas.\n\n" +
              formatJson({ resumo, contas: rows })
          ),
        ],
      };
    }
  );

  ctx.mcp.registerTool(
    "update_account_settings",
    {
      description: [
        "Altera configurações da conta (Customer): auto-tagging, tracking template, sufixo de URL final,",
        "relatório de chamadas e nome. WRITE OPERATION — vale para TODAS as campanhas da conta.",
        "",
        "Lê a conta antes, mostra antes → depois e não grava nada se nada muda. Sem confirm: true só devolve a",
        "prévia. String vazia (\"\") limpa trackingUrlTemplate, finalUrlSuffix ou callConversionActionId.",
        "O tracking template precisa conter {lpurl} (ou variante) — sem isso a landing page quebra.",
        "Desligar o auto-tagging quebra a importação de conversões do GA4 e o upload offline por GCLID.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        descriptiveName: z.string().optional().describe("Novo nome da conta."),
        autoTaggingEnabled: z.boolean().optional().describe("Liga/desliga o auto-tagging (GCLID)."),
        trackingUrlTemplate: z.string().optional().describe("Tracking template da conta (com {lpurl}). \"\" limpa."),
        finalUrlSuffix: z.string().optional().describe("Sufixo de URL final da conta (ex.: utm_source=google&utm_medium=cpc). \"\" limpa."),
        callReportingEnabled: z.boolean().optional().describe("Relatório de chamadas (encaminhamento pelo Google)."),
        callConversionReportingEnabled: z.boolean().optional().describe("Conversões de chamada."),
        callConversionActionId: z.string().optional().describe("ID da ação de conversão de chamada da conta. \"\" volta para a padrão."),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar. Sem ele a tool só mostra a prévia."),
      },
    },
    async (args) => {
      const {
        customerId,
        descriptiveName,
        autoTaggingEnabled,
        trackingUrlTemplate,
        finalUrlSuffix,
        callReportingEnabled,
        callConversionReportingEnabled,
        callConversionActionId,
        confirm,
      } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`);

      const provided = [descriptiveName, autoTaggingEnabled, trackingUrlTemplate, finalUrlSuffix, callReportingEnabled, callConversionReportingEnabled, callConversionActionId]
        .filter((v) => v !== undefined).length;
      if (provided === 0) return fail("Nada para alterar: informe ao menos um campo (autoTaggingEnabled, trackingUrlTemplate, ...).");
      if (descriptiveName !== undefined && !descriptiveName.trim()) return fail("descriptiveName não pode ser vazio.");
      const template = trackingUrlTemplate?.trim();
      if (template && !LPURL_TAG.test(template)) {
        return fail(
          `trackingUrlTemplate sem {lpurl}: "${template}". O template de conta precisa de uma tag que insere a URL final ` +
            "({lpurl}, {lpurl+2}, {lpurl+3}, {unescapedlpurl}, {escapedlpurl}) — sem ela a landing page quebra. Nada foi enviado."
        );
      }
      const suffix = finalUrlSuffix?.trim();
      const actionId = callConversionActionId?.trim();
      if (actionId && !/^\d+$/.test(actionId)) return fail(`callConversionActionId inválido: "${callConversionActionId}" — use o ID numérico.`);

      const client = ctx.getClient();
      const before = await readSettings(client, cid);
      if (!before) return fail(`A API não devolveu dados da conta ${cid} — nada foi alterado.`);

      const actionResource = actionId ? `customers/${cid}/conversionActions/${actionId}` : actionId === "" ? "" : undefined;
      type Change = { path: string; campo: string; antes: unknown; depois: unknown; apply: (update: Row) => void };
      const changes: Change[] = [];
      const call: Row = {};
      const consider = (path: string, campo: string, current: unknown, desired: unknown, apply: (update: Row) => void) => {
        if (desired === undefined) return;
        const normalizedCurrent = current ?? (typeof desired === "string" ? "" : null);
        if (normalizedCurrent === desired) return;
        changes.push({ path, campo, antes: current ?? null, depois: desired === "" ? null : desired, apply });
      };
      consider("descriptive_name", "descriptiveName", before.nome, descriptiveName?.trim(), (u) => (u.descriptiveName = descriptiveName?.trim()));
      consider("auto_tagging_enabled", "autoTaggingEnabled", before.auto_tagging, autoTaggingEnabled, (u) => (u.autoTaggingEnabled = autoTaggingEnabled));
      // Limpar = caminho no updateMask sem o campo no objeto (semântica de FieldMask).
      consider("tracking_url_template", "trackingUrlTemplate", before.tracking_url_template, template, (u) => {
        if (template) u.trackingUrlTemplate = template;
      });
      consider("final_url_suffix", "finalUrlSuffix", before.final_url_suffix, suffix, (u) => {
        if (suffix) u.finalUrlSuffix = suffix;
      });
      consider("call_reporting_setting.call_reporting_enabled", "callReportingEnabled", before.call_reporting.ativado, callReportingEnabled, () => {
        call.callReportingEnabled = callReportingEnabled;
      });
      consider(
        "call_reporting_setting.call_conversion_reporting_enabled",
        "callConversionReportingEnabled",
        before.call_reporting.conversao_de_chamada,
        callConversionReportingEnabled,
        () => {
          call.callConversionReportingEnabled = callConversionReportingEnabled;
        }
      );
      consider("call_reporting_setting.call_conversion_action", "callConversionActionId", before.call_reporting.acao_de_conversao, actionResource, () => {
        if (actionResource) call.callConversionAction = actionResource;
      });

      if (changes.length === 0) {
        return { content: [text(`Nada muda na conta ${cid}: os valores pedidos já estão em vigor. Nenhuma escrita enviada.`)] };
      }

      const warnings: string[] = [];
      if (changes.some((c) => c.path === "auto_tagging_enabled" && c.depois === false)) {
        warnings.push("ATENÇÃO: desligar o auto-tagging tira o GCLID das URLs — quebra a importação de conversões do GA4 e o upload offline por GCLID.");
      }
      if (actionResource) {
        const rows = await client.searchStream(
          cid,
          `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status
           FROM conversion_action
           WHERE conversion_action.id = ${actionId}`
        );
        const action = ((rows[0] ?? {}).conversionAction ?? null) as Row | null;
        if (!action) return fail(`Ação de conversão ${actionId} não existe na conta ${cid}. Nada foi enviado.`);
        if (action.status === "REMOVED") return fail(`Ação de conversão ${actionId} (${action.name}) está REMOVIDA. Nada foi enviado.`);
        const reporting = callConversionReportingEnabled ?? before.call_reporting.conversao_de_chamada;
        if (reporting !== true) {
          warnings.push("A ação de conversão de chamada só vale com callConversionReportingEnabled=true.");
        }
      }

      const preview = changes.map(({ campo, path, antes, depois }) => ({ campo, path, antes, depois }));
      if (!client.isDryRun && confirm !== true) {
        return {
          content: [
            text(
              `Prévia — NADA foi gravado. Configurações de conta valem para todas as campanhas: reenvie com confirm: true para aplicar.\n` +
                `${warnings.length ? `${warnings.join("\n")}\n` : ""}\n${formatJson(preview)}`
            ),
          ],
          isError: true,
        };
      }

      const update: Row = { resourceName: `customers/${cid}` };
      for (const change of changes) change.apply(update);
      if (Object.keys(call).length) update.callReportingSetting = call;
      const updateMask = changes.map((c) => c.path).join(",");
      const response = await client.mutateCustomer(cid, { update, updateMask });

      if (client.isDryRun) {
        return {
          content: [
            text(
              `VALIDADO (dry-run/validateOnly) — nada foi gravado na conta ${cid}. A API aceitou:\n` +
                `${warnings.length ? `${warnings.join("\n")}\n` : ""}\n${formatJson({ updateMask, alteracoes: preview })}`
            ),
          ],
        };
      }
      const after = await readSettings(client, cid);
      return {
        content: [
          text(
            `Conta ${cid} atualizada (${changes.length} campo(s)).\n${warnings.length ? `${warnings.join("\n")}\n` : ""}\n` +
              formatJson({
                resource_name: ((response.result ?? {}) as Row).resourceName ?? `customers/${cid}`,
                updateMask,
                alteracoes: preview,
                ...(after ? { lido_depois: after } : {}),
              })
          ),
        ],
      };
    }
  );

  // ── Verificação de identidade do anunciante ────────────────────────

  ctx.mcp.registerTool(
    "get_identity_verification",
    {
      description: [
        "Verificação de identidade do anunciante: status (PENDING_USER_ACTION, PENDING_REVIEW, SUCCESS, FAILURE),",
        "prazos de início e conclusão e o link de ação. READ OPERATION.",
        "Se o prazo passar sem a verificação concluída, a conta pode ser pausada.",
        "allAccounts=true lista as contas-cliente do MCC que precisam de ação, ordenadas pelo prazo.",
        "A API limita este método: o resultado fica em cache por 6 h (refresh=true força nova consulta).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Customer ID (use este OU allAccounts)."),
        allAccounts: z.boolean().optional().describe("Varre as contas-cliente ativas e suspensas do MCC do login."),
        refresh: z.boolean().optional().describe("Ignora o cache de 6 h. Default: false."),
        maxAccounts: z.number().optional().describe("allAccounts: máximo de contas consultadas. Default: 100 (máx. 500)."),
        format: formatSchema,
      },
    },
    async ({ customerId, allAccounts, refresh, maxAccounts, format }) => {
      if (Boolean(customerId) === Boolean(allAccounts)) return fail("Informe customerId OU allAccounts=true (um dos dois).");
      if (customerId) {
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const cid = normalizeCid(customerId);
        if (!cid) return fail(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`);
        const client = ctx.getClient();
        const { response, cachedAt, fromCache } = await fetchIdentityVerification(client, cid, refresh === true);
        const views = summarizeVerification(response);
        const needsAction = views.some((v) => ACTIONABLE_STATUSES.has(v.status));
        const body = {
          customer_id: cid,
          exigida: views.length > 0,
          verificacoes: views,
          consultado_em: new Date(cachedAt).toISOString(),
          do_cache: fromCache,
          nota: "Prazos no formato da API (yyyy-MM-dd HH:mm:ss, fuso não documentado).",
        };
        if (format === "table" || format === "csv") {
          const flat = views.map((v) => ({ customer_id: cid, ...v }));
          return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
        }
        const header = views.length === 0
          ? `Conta ${cid}: verificação de identidade não exigida.`
          : `Conta ${cid}: ${describeVerification(views)}.${needsAction ? " Ação necessária — use o action_url (ou start_identity_verification se o link expirou)." : ""}`;
        return { content: [text(`${header}\n\n${formatJson(body)}`)] };
      }

      const cap = capAccounts(maxAccounts);
      const client = ctx.getClient();
      const accounts = (await scopedClientAccounts(ctx, client, ["ENABLED", "SUSPENDED"])).slice(0, cap);
      // Poucas chamadas em paralelo: o método é rate-limited.
      const results = await mapLimit(accounts, 2, async (account) => {
        try {
          const { response, fromCache } = await fetchIdentityVerification(client, account.id, refresh === true);
          return { account, views: summarizeVerification(response), fromCache };
        } catch (err) {
          return { account, erro: errorMessage(err) };
        }
      });
      const rows = results.flatMap((r) =>
        "views" in r && r.views
          ? r.views.map((v) => ({ customer_id: r.account.id, nome: r.account.name, status_conta: r.account.status, ...v }))
          : []
      );
      const byDeadline = (a: VerificationView, b: VerificationView) =>
        (parseApiDateTime(a.prazo_conclusao) ?? Number.MAX_SAFE_INTEGER) - (parseApiDateTime(b.prazo_conclusao) ?? Number.MAX_SAFE_INTEGER);
      const pendentes = rows.filter((r) => ACTIONABLE_STATUSES.has(r.status)).sort(byDeadline);
      const emAnalise = rows.filter((r) => r.status === "PENDING_REVIEW").sort(byDeadline);
      const resumo = {
        contas_consultadas: accounts.length,
        precisam_de_acao: pendentes.length,
        em_analise: emAnalise.length,
        concluidas: rows.filter((r) => r.status === "SUCCESS").length,
        nao_exigida: results.filter((r) => "views" in r && r.views && r.views.length === 0).length,
        erros: results.filter((r) => "erro" in r).length,
      };
      if (format === "table" || format === "csv") {
        const flat = [...pendentes, ...emAnalise];
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      return {
        content: [
          text(
            `${pendentes.length} conta(s) precisam de ação na verificação de identidade (ordenadas pelo prazo de conclusão).\n\n` +
              formatJson({
                resumo,
                precisam_de_acao: pendentes,
                em_analise: emAnalise,
                erros: results.flatMap((r) => ("erro" in r ? [{ customer_id: r.account.id, nome: r.account.name, erro: r.erro }] : [])),
              })
          ),
        ],
      };
    }
  );

  ctx.mcp.registerTool(
    "start_identity_verification",
    {
      description: [
        "Inicia uma sessão de verificação de identidade do anunciante (programa ADVERTISER_IDENTITY_VERIFICATION)",
        "e devolve o link de ação. WRITE OPERATION — exige confirm: true.",
        "Só inicia quando a conta precisa de verificação e não há sessão aberta: se já existe link válido ou a",
        "verificação está em análise/concluída, nada é enviado. O método não tem validate_only: em dry-run/",
        "validateOnly a tool só mostra o estado atual.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        confirm: z.boolean().optional().describe("Precisa ser true para iniciar a sessão."),
      },
    },
    async ({ customerId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`);
      const client = ctx.getClient();
      // Estado atual sem cache: iniciar depende dele.
      const { response } = await fetchIdentityVerification(client, cid, true);
      const views = summarizeVerification(response);
      if (views.length === 0) {
        return fail(`A conta ${cid} não precisa de verificação de identidade (a API não lista nenhuma). Nada foi enviado.`);
      }
      const current = views.find((v) => v.programa === "ADVERTISER_IDENTITY_VERIFICATION") ?? views[0];
      const state = formatJson(current);
      if (current.status === "SUCCESS") {
        return { content: [text(`Verificação já concluída (SUCCESS) na conta ${cid}. Nada foi enviado.\n\n${state}`)] };
      }
      if (current.status === "PENDING_REVIEW") {
        return { content: [text(`Verificação em análise pelo Google (PENDING_REVIEW) na conta ${cid}. Nada foi enviado.\n\n${state}`)] };
      }
      const linkExpiry = parseApiDateTime(current.link_expira_em);
      if (current.status === "PENDING_USER_ACTION" && current.action_url && (linkExpiry === null || linkExpiry > Date.now())) {
        return {
          content: [text(`Já existe uma sessão aberta na conta ${cid}: use o action_url abaixo. Nada foi enviado.\n\n${state}`)],
        };
      }
      if (client.isDryRun) {
        return fail(
          "StartIdentityVerification não tem validate_only: em dry-run/validateOnly nada é enviado. " +
            `Estado atual da conta ${cid}:\n\n${state}`
        );
      }
      if (confirm !== true) {
        return fail(`Iniciar a verificação abre uma nova sessão na conta ${cid}. Reenvie com confirm: true.\n\nEstado atual:\n${state}`);
      }
      await client.startIdentityVerification(cid);
      const { response: afterResponse } = await fetchIdentityVerification(client, cid, true);
      const after = summarizeVerification(afterResponse);
      const link = after.find((v) => v.action_url)?.action_url;
      return {
        content: [
          text(
            `Sessão de verificação iniciada na conta ${cid}.${link ? ` Link de ação: ${link}` : " A API ainda não devolveu o link — consulte get_identity_verification com refresh=true em alguns minutos."}\n\n` +
              formatJson({ antes: current, depois: after })
          ),
        ],
      };
    }
  );

  // ── Metadados GAQL ─────────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_gaql_fields",
    {
      description: [
        "Metadados reais dos campos GAQL (GoogleAdsFieldService) — READ OPERATION, não lê dados de conta.",
        "Use antes de escrever uma query para run_gaql:",
        "- resource: campos do recurso (selecionável/filtrável/ordenável, tipo, valores de enum), recursos atribuídos",
        "  e de segmentação, segmentos e métricas compatíveis com ele no FROM;",
        "- fields: detalhes de campos específicos (com selectable_with quando é um só);",
        "- namePrefix: busca por prefixo (ex.: 'segments.', 'metrics.conversions').",
        "Resultados ficam em cache no servidor (os metadados só mudam com a versão da API).",
      ].join("\n"),
      inputSchema: {
        resource: z.string().optional().describe("Recurso do FROM (ex.: campaign, search_term_view)."),
        fields: flexArray(z.string()).optional().describe("Campos específicos (máx. 25), ex.: ['campaign.status','metrics.clicks']."),
        namePrefix: z.string().optional().describe("Prefixo de nome (ex.: 'segments.', 'metrics.conv')."),
        nameContains: z.string().optional().describe("Filtra campos/segmentos/métricas pelo trecho do nome (modo resource)."),
        include: flexArray(z.enum(["fields", "segments", "metrics", "resources"])).optional().describe(
          "Modo resource: o que devolver. Default: tudo."
        ),
        customerId: z.string().optional().describe("Opcional: conta em cujo contexto a consulta é feita (só confere o acesso)."),
      },
    },
    async ({ resource, fields, namePrefix, nameContains, include, customerId }) => {
      if (customerId !== undefined) {
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const fieldList = ensureArray<string>(fields ?? []).map((f) => String(f).trim()).filter(Boolean);
      const modes = [resource ? 1 : 0, fieldList.length ? 1 : 0, namePrefix ? 1 : 0].reduce((a, b) => a + b, 0);
      if (modes !== 1) return fail("Informe exatamente um: resource, fields ou namePrefix.");
      const client = ctx.getClient();

      if (resource) {
        const name = resource.trim();
        if (!FIELD_NAME.test(name) || name.includes(".")) return fail(`resource inválido: "${resource}" (ex.: campaign, ad_group_ad).`);
        let meta: FieldMeta;
        try {
          meta = await fieldMeta(client, name);
        } catch (err) {
          return fail(`Recurso "${name}" não encontrado: ${errorMessage(err)}`);
        }
        if (meta.category !== "RESOURCE") return fail(`"${name}" não é um recurso (categoria ${meta.category}). Use fields=["${name}"].`);
        const wanted = new Set(ensureArray<string>(include ?? []).length ? ensureArray<string>(include ?? []) : ["fields", "segments", "metrics", "resources"]);
        const needle = nameContains?.trim().toLowerCase();
        const match = (n: string) => !needle || n.toLowerCase().includes(needle);
        const body: Row = { recurso: name };
        if (wanted.has("resources")) {
          body.recursos_atribuidos = meta.attributeResources;
          body.recursos_de_segmentacao = meta.segments.filter((s) => !s.startsWith("segments."));
        }
        if (wanted.has("segments")) body.segmentos = meta.segments.filter((s) => s.startsWith("segments.") && match(s));
        if (wanted.has("metrics")) body.metricas = meta.metrics.filter(match);
        if (wanted.has("fields")) {
          const attributes = await fieldsUnder(client, name);
          body.campos = attributes.filter((f) => match(f.name)).map((f) => fieldView(f, false));
        }
        body.regras = [
          "Campo de recurso de segmentação ou segmento (exceto date/week/month/quarter/year) usado no WHERE precisa estar no SELECT.",
          "Segmento de data no SELECT exige período finito no WHERE.",
          "Recurso atribuído não segmenta as métricas; recurso de segmentação e segmentos, sim.",
        ];
        return { content: [text(formatJson(body))] };
      }

      if (fieldList.length) {
        if (fieldList.length > 25) return fail(`Máximo de 25 campos por chamada (recebidos ${fieldList.length}).`);
        const invalid = fieldList.filter((f) => !FIELD_NAME.test(f));
        if (invalid.length) return fail(`Nome(s) de campo inválido(s): ${invalid.join(", ")}.`);
        const out = await Promise.all(
          fieldList.map(async (name) => {
            try {
              return fieldView(await fieldMeta(client, name), fieldList.length === 1);
            } catch (err) {
              return { name, erro: `não encontrado: ${errorMessage(err).split("\n")[0]}` };
            }
          })
        );
        return { content: [text(formatJson(out))] };
      }

      const prefix = (namePrefix as string).trim();
      if (!/^[a-z][a-z0-9_.]*$/.test(prefix)) return fail(`namePrefix inválido: "${namePrefix}" (letras minúsculas, dígitos, _ e .).`);
      const rows = await client.searchGoogleAdsFields(
        `SELECT name, category, selectable, filterable, sortable, data_type, is_repeated WHERE name LIKE '${prefix}%'`
      );
      const matches = (Array.isArray(rows) ? rows : []).map(toFieldMeta).filter((f) => f.name.startsWith(prefix));
      const shown = matches.slice(0, 500).map((f) => fieldView(f, false));
      return {
        content: [text(`${matches.length} campo(s) com prefixo "${prefix}"${matches.length > shown.length ? ` (mostrando ${shown.length})` : ""}.\n\n${formatJson(shown)}`)],
      };
    }
  );

  ctx.mcp.registerTool(
    "validate_gaql",
    {
      description: [
        "Confere uma query GAQL contra os metadados reais da API ANTES de rodar (não executa a query nem lê a conta).",
        "READ OPERATION. Aponta: campo inexistente (com sugestão de nome), campo incompatível com o FROM,",
        "não selecionável/filtrável/ordenável, segmento ou recurso de segmentação no WHERE fora do SELECT e",
        "segmento de data no SELECT sem período no WHERE. Depois rode com run_gaql.",
      ].join("\n"),
      inputSchema: {
        query: z.string().describe("Query GAQL completa (SELECT ... FROM ... WHERE ...)."),
        customerId: z.string().optional().describe("Opcional: conta em cujo contexto a query será usada (só confere o acesso)."),
      },
    },
    async ({ query, customerId }) => {
      if (customerId !== undefined) {
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const client = ctx.getClient();
      const { from, errors, checked } = await validateGaqlLive(client, query);
      if (errors.length === 0) {
        return { content: [text(`Query válida para FROM ${from} (${checked} referência(s) de campo conferidas). Rode com run_gaql.`)] };
      }
      return {
        content: [
          text(
            `Query inválida (${errors.length} problema(s))${from ? ` — FROM ${from}` : ""}:\n- ${errors.join("\n- ")}\n\n` +
              `Veja os campos compatíveis com get_gaql_fields${from ? ` (resource="${from}")` : ""}.`
          ),
        ],
        isError: true,
      };
    }
  );
}
