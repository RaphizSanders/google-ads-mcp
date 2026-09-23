/**
 * Helpers compartilhados pelas tools do Google Ads MCP: formatação, datas, GAQL,
 * validateOnly por chamada, lances, AI Max, imagens, conversões e o guarda de conta.
 * Extraídos de tools.ts para que os módulos em src/tools/ possam usá-los.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GoogleAdsClient } from "./google-ads-client.js";
import { GOOGLE_ADS_WRITE_TOOL_NAMES } from "./read-only.js";
import { MODULE_CHAINED_WRITE_TOOLS } from "./tools/catalogs.js";

/** O que cada módulo de tools recebe para registrar as suas. */
export interface ToolContext {
  mcp: McpServer;
  getClient: () => GoogleAdsClient;
  allowedCustomerIds: string[];
  hosted: boolean;
}


export const text = (s: string) => ({ type: "text" as const, text: s });

export function formatJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2) ?? "null";
}

/** Convert cost_micros (string or number) to currency value */
export function microsToMoney(micros: unknown): number {
  return Number(micros ?? 0) / 1_000_000;
}

/** "Últimos N dias" que o GAQL aceita em DURING — não existe LAST_60_DAYS nem LAST_90_DAYS. */
export const DURING_LAST_N_DAYS = new Set([7, 14, 30]);
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Retenção de dados do Google Ads (desde 01/06/2026): dados granulares — diários, semanais e
 * por hora — ficam só pelos últimos 37 meses; mensais, trimestrais e anuais, por 11 anos.
 * Fonte: developers.google.com/google-ads/api/docs/deprecations e o Ads Developer Blog de
 * 01/05/2026 ("New Data Retention Policy for Google Ads starting June 1, 2026"): query com
 * segments.date/segments.week para período mais antigo que 37 meses recebe
 * DateRangeError.INVALID_DATE, e query sem segmento de data para período histórico só passa
 * alinhada ao mês civil (dia 1 ao último dia do mês).
 */
export const GRANULAR_RETENTION_MONTHS = 37;

/** Primeiro dia (data local do servidor) que ainda tem dado diário/semanal/por hora. */
export function granularRetentionStart(now: Date = new Date()): string {
  return localIsoDate(new Date(now.getFullYear(), now.getMonth() - GRANULAR_RETENTION_MONTHS, now.getDate()));
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return localIsoDate(new Date(y, m - 1, d)) === value;
}

function lastDayOfMonth(value: string): string {
  const [y, m] = value.split("-").map(Number);
  return localIsoDate(new Date(y, m, 0));
}

export interface DateClauseOptions {
  /**
   * true quando a query seleciona segments.date, segments.week ou segments.hour: período
   * mais antigo que 37 meses é recusado aqui, com a saída (granularidade mensal) no texto.
   */
  granular?: boolean;
}

/**
 * Confere o período contra a retenção de 37 meses e devolve um aviso pronto (ou null).
 * Granular antigo: erro. Sem segmento de data e antigo: só passa alinhado ao mês.
 */
export function retentionProblem(since: string, until: string, options: DateClauseOptions = {}, now: Date = new Date()): string | null {
  const start = granularRetentionStart(now);
  if (since >= start) return null;
  if (options.granular) {
    return `Dados diários, semanais e por hora só existem para os últimos ${GRANULAR_RETENTION_MONTHS} meses ` +
      `(desde ${start}); o período pedido começa em ${since}. Para histórico mais antigo use granularidade ` +
      "mensal, trimestral ou anual (segments.month/quarter/year — em get_daily_trend, granularity MONTH) " +
      "com o período alinhado ao mês, ou comece o período a partir dessa data.";
  }
  const aligned = since.endsWith("-01") && until === lastDayOfMonth(until);
  if (aligned) return null;
  const today = localIsoDate(now);
  const suggestedUntil = lastDayOfMonth(until) < today
    ? lastDayOfMonth(until)
    : localIsoDate(new Date(Number(until.slice(0, 4)), Number(until.slice(5, 7)) - 1, 0));
  return `Períodos que começam antes de ${start} (limite de ${GRANULAR_RETENTION_MONTHS} meses dos dados diários) ` +
    "só são aceitos pela API alinhados ao mês civil: since no dia 1 e until no último dia de um mês. " +
    `Sugestão: since ${since.slice(0, 8)}01 e until ${suggestedUntil}.`;
}

/** Build GAQL date clause from dateRange or days */
export function buildDateClause(
  dateRange?: { since: string; until: string },
  days?: number,
  options: DateClauseOptions = {}
): string {
  // Só uma das pontas preenchida: cair em `days` trocaria o período em silêncio.
  if (Boolean(dateRange?.since) !== Boolean(dateRange?.until)) {
    throw new Error(
      `dateRange incompleto — informe since e until (YYYY-MM-DD) ou omita dateRange para usar days ` +
        `(recebido "${dateRange?.since ?? ""}" → "${dateRange?.until ?? ""}").`
    );
  }
  if (dateRange?.since && dateRange?.until) {
    // As datas entram direto na string GAQL: só formato ISO passa
    if (!ISO_DATE.test(dateRange.since) || !ISO_DATE.test(dateRange.until)) {
      throw new Error(`dateRange inválido — use YYYY-MM-DD (recebido ${dateRange.since} → ${dateRange.until}).`);
    }
    if (!isRealIsoDate(dateRange.since) || !isRealIsoDate(dateRange.until)) {
      throw new Error(`dateRange inválido — data inexistente no calendário (recebido ${dateRange.since} → ${dateRange.until}).`);
    }
    if (dateRange.since > dateRange.until) {
      throw new Error(`dateRange inválido — since (${dateRange.since}) é depois de until (${dateRange.until}).`);
    }
    const problem = retentionProblem(dateRange.since, dateRange.until, options);
    if (problem) throw new Error(problem);
    return `segments.date BETWEEN '${dateRange.since}' AND '${dateRange.until}'`;
  }
  const n = days ?? 30;
  if (!Number.isInteger(n) || n < 1) throw new Error(`days inválido: ${days}. Use um inteiro positivo.`);
  if (DURING_LAST_N_DAYS.has(n)) return `segments.date DURING LAST_${n}_DAYS`;
  // Demais janelas viram BETWEEN, terminando ontem como os DURING LAST_N_DAYS.
  // Usa a data local do servidor: perto da meia-noite pode diferir 1 dia do fuso da conta.
  const until = new Date();
  until.setDate(until.getDate() - 1);
  const since = new Date();
  since.setDate(since.getDate() - n);
  const problem = retentionProblem(localIsoDate(since), localIsoDate(until), options);
  if (problem) throw new Error(`days=${n}: ${problem} Use dateRange.`);
  return `segments.date BETWEEN '${localIsoDate(since)}' AND '${localIsoDate(until)}'`;
}

/* change_event nao aceita segments.date: o recurso filtra pelo proprio
   change_date_time, em datetime e nao em data. A API tambem exige LIMIT e
   recusa "start date is too old" no limite exato de 30 dias — a janela maxima
   real e 29. dateRange fora do formato YYYY-MM-DD ou alem da janela e recusado
   aqui com mensagem clara, em vez do erro cru da API. */
export const CHANGE_EVENT_MAX_DAYS = 29;
export function buildChangeEventDateClause(dateRange?: { since: string; until: string }, days?: number): string {
  const iso = (d: Date) => d.toISOString().split("T")[0];
  const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (dateRange && (dateRange.since || dateRange.until)) {
    if (!dateRange.since || !dateRange.until) {
      throw new Error("get_change_history: dateRange precisa de since E until (ou use days).");
    }
    if (!isIso(dateRange.since) || !isIso(dateRange.until)) {
      throw new Error(`get_change_history: dateRange precisa de datas YYYY-MM-DD (recebido ${dateRange.since} / ${dateRange.until}).`);
    }
    const spanDays = Math.round((Date.parse(dateRange.until) - Date.parse(dateRange.since)) / 86_400_000);
    const ageDays = Math.round((Date.now() - Date.parse(dateRange.since)) / 86_400_000);
    if (spanDays < 0 || ageDays > CHANGE_EVENT_MAX_DAYS) {
      throw new Error(`get_change_history: a API só devolve os últimos ${CHANGE_EVENT_MAX_DAYS} dias — since não pode ser anterior a ${iso(new Date(Date.now() - CHANGE_EVENT_MAX_DAYS * 86_400_000))}.`);
    }
    return `change_event.change_date_time >= '${dateRange.since} 00:00:00' AND change_event.change_date_time <= '${dateRange.until} 23:59:59'`;
  }
  const janela = Math.min(days ?? CHANGE_EVENT_MAX_DAYS, CHANGE_EVENT_MAX_DAYS);
  const ate = new Date();
  const de = new Date(ate.getTime() - janela * 86_400_000);
  return `change_event.change_date_time >= '${iso(de)} 00:00:00' AND change_event.change_date_time <= '${iso(ate)} 23:59:59'`;
}

/** Format GAQL results as table string */
export function formatAsTable(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) return "(no results)";

  // Flatten nested objects
  const flat = results.map((r) => flattenObj(r));
  const keys = [...new Set(flat.flatMap(Object.keys))];

  // Calculate column widths
  const widths = keys.map((k) =>
    Math.max(k.length, ...flat.map((row) => String(row[k] ?? "").length))
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const rows = flat.map((row) =>
    keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join(" | ")
  );

  return [header, separator, ...rows].join("\n");
}

/** Format GAQL results as CSV string */
export function formatAsCsv(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) return "";
  const flat = results.map((r) => flattenObj(r));
  const keys = [...new Set(flat.flatMap(Object.keys))];
  const header = keys.join(",");
  const rows = flat.map((row) =>
    keys.map((k) => {
      const v = String(row[k] ?? "");
      return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

/** Flatten nested object: { campaign: { name: "X" } } → { "campaign.name": "X" } */
export function flattenObj(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenObj(v as Record<string, unknown>, key));
    } else {
      result[key] = String(v ?? "");
    }
  }
  return result;
}

/** Extract a numeric metric safely */
export function num(val: unknown): number {
  return Number(val ?? 0) || 0;
}

// ── Shared schemas ───────────────────────────────────────────────────

export const dateRangeSchema = z
  .object({
    since: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
    until: z.string().describe("End date YYYY-MM-DD (inclusive)"),
  })
  .optional();

export const formatSchema = z
  .enum(["json", "table", "csv"])
  .optional()
  .describe("Output format. Default: json.");

export const DATE_RANGE_DESC =
  "Custom date range (use this OR days, not both). since and until in YYYY-MM-DD.";

export const DAYS_DESC =
  "Number of days to look back (use this OR dateRange, not both). Default: 30.";

// ── Helpers ──────────────────────────────────────────────────────────

/** Ensure value is an array — handles string-serialized arrays from some MCP clients */
export function ensureArray<T>(val: T[] | string | unknown): T[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { const parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed; } catch {}
    // String simples (nao-JSON) vira um elemento — descartar perderia o valor do usuario
    return val.trim() ? ([val] as unknown as T[]) : [];
  }
  return [];
}

/** Zod schema that accepts both array and JSON string of array */
export function flexArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.union([z.array(itemSchema), z.string().transform((s) => {
    try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed; } catch {}
    return s.trim() ? [s] : [];
  })]);
}

/**
 * Escapa um valor para uso dentro de uma string literal GAQL.
 * Preserva apostrofos legitimos (ex: "Sant'Ana") em vez de remove-los.
 */
export function gaqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ── validateOnly por chamada ─────────────────────────────────────────

/** Marca a chamada em curso como validateOnly; getClient devolve um client em dry-run. */
export const validateOnlyScope = new AsyncLocalStorage<boolean>();
export const VALIDATE_ONLY_BANNER = "VALIDATE-ONLY: modo validação (validate_only) — nada foi gravado na conta.";

/**
 * Tools que gravam em passos encadeados: o segundo passo usa o ID criado no primeiro.
 * Em validate_only a API não devolve IDs, então o segundo passo falharia por um motivo
 * falso. Nelas o validateOnly recusa a chamada sem enviar nada. O parâmetro continua
 * no schema de propósito: sem ele, um validateOnly:true seria descartado pelo schema e
 * a chamada gravaria de verdade.
 */
export const CHAINED_WRITE_TOOLS = new Set([
  // Só o que ainda grava em passos dependentes. As criações de campanha (PMax, Display, Shopping,
  // Demand Gen), asset group, extensões e listas de negativas passaram a ir num único googleAds:mutate
  // atômico com IDs temporários — nelas o validateOnly valida o pedido inteiro.
  "create_video_ad",
  ...MODULE_CHAINED_WRITE_TOOLS,
]);

/**
 * Acrescenta o parâmetro opcional validateOnly a toda tool de escrita. Com
 * validateOnly=true a chamada roda num client em dry-run (validate_only na
 * mutação) e a resposta ganha um aviso no topo. Tools de leitura não mudam.
 */
export function withValidateOnlyParam<T extends object>(server: T): T {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      const registerTool = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => {
        if (!GOOGLE_ADS_WRITE_TOOL_NAMES.has(name as never)) {
          return Reflect.apply(registerTool, target, [name, config, handler]);
        }
        const inputSchema = {
          ...((config.inputSchema as Record<string, unknown>) ?? {}),
          validateOnly: z.boolean().optional().describe(
            "true = só valida na API, sem gravar nada. Use para conferir antes de aplicar (o nome é exatamente validateOnly; outra grafia é ignorada e a chamada grava)."
          ),
        };
        const banner = { type: "text", text: VALIDATE_ONLY_BANNER };
        const wrapped = async (args: Record<string, unknown>, ...rest: unknown[]) => {
          if (args?.validateOnly !== true) return handler(args, ...rest);
          if (CHAINED_WRITE_TOOLS.has(name)) {
            return {
              content: [banner, {
                type: "text",
                text: `validateOnly não é suportado em ${name}: a tool grava em passos encadeados (o segundo usa o ID ` +
                  "criado no primeiro) e em validate_only a API não devolve IDs. Nada foi enviado.",
              }],
              isError: true,
            };
          }
          try {
            const result = (await validateOnlyScope.run(true, async () => handler(args, ...rest))) as
              | { content?: unknown[] }
              | undefined;
            return { ...result, content: [banner, ...(result?.content ?? [])] };
          } catch (err) {
            return { content: [banner, { type: "text", text: `Erro: ${(err as Error).message}` }], isError: true };
          }
        };
        return Reflect.apply(registerTool, target, [name, { ...config, inputSchema }, wrapped]);
      };
    },
  });
}

// ── Lances ───────────────────────────────────────────────────────────

/** Abaixo disso o lance quase certamente é engano (o incidente real foi R$ 0,01). */
export const LOW_BID_MICROS = 100_000;

/** Estratégias em que o lance do grupo / da palavra-chave é o lance de fato. */
export const MANUAL_BID_STRATEGIES = new Set(["MANUAL_CPC", "ENHANCED_CPC", "MANUAL_CPM", "MANUAL_CPV"]);

export const money = (micros: unknown) => `R$ ${(num(micros) / 1_000_000).toFixed(2)}`;

export function isPositiveMicros(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Traduz a recusa da API para CPC manual em campanha nova. */
export function explainBiddingError(message: string, strategy: string | undefined): string {
  if (strategy === "MANUAL_CPC" && /not allowed for the given context|OPERATION_NOT_PERMITTED_FOR_CONTEXT/i.test(message)) {
    return `${message}\nA API recusou CPC manual para esta campanha. Use TARGET_SPEND (Maximizar cliques, ` +
      "com cpcBidCeilingMicros como teto) ou uma estratégia de conversão.";
  }
  return message;
}

// ── Imagens em campanhas de Pesquisa (AD_IMAGE) ─────────────────────

/** O Google aceita até 20 imagens por campanha de Pesquisa. */
export const MAX_CAMPAIGN_IMAGES_PER_CALL = 20;

/**
 * Normaliza a referência de uma imagem para customers/{cid}/assets/{id}.
 * Aceita o resource name completo ou só o ID numérico. Resource name de outra
 * conta é recusado aqui, antes de qualquer chamada à API.
 */
export function parseImageAssetRef(
  ref: string,
  cid: string
): { assetId: string; resourceName: string } | { error: string } {
  const value = ref.trim();
  if (/^\d+$/.test(value)) {
    return { assetId: value, resourceName: `customers/${cid}/assets/${value}` };
  }
  const match = /^customers\/([\d-]+)\/assets\/(\d+)$/.exec(value);
  if (!match) {
    return {
      error: `"${ref}" não é uma referência de asset válida (esperado customers/{customerId}/assets/{assetId} ou o ID numérico).`,
    };
  }
  const owner = match[1].replace(/-/g, "");
  if (owner !== cid) {
    return { error: `${value} pertence à conta ${owner}, não à conta ${cid}.` };
  }
  return { assetId: match[2], resourceName: `customers/${cid}/assets/${match[2]}` };
}

/**
 * Vínculos AD_IMAGE de uma campanha, em qualquer status, por asset id.
 * Filtra por campaign_asset.campaign (atributo) e não por campaign.id: em
 * FROM campaign_asset, campaign é recurso de segmentação, e segmento no WHERE
 * precisa estar no SELECT — senão a API recusa a query.
 */
export async function fetchCampaignImageLinks(
  client: GoogleAdsClient,
  customerId: string,
  campaignResource: string
): Promise<Map<string, { status: string; resourceName: string }>> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign_asset.asset, campaign_asset.status, campaign_asset.resource_name
     FROM campaign_asset
     WHERE campaign_asset.campaign = '${campaignResource}'
       AND campaign_asset.field_type = 'AD_IMAGE'`);
  const links = new Map<string, { status: string; resourceName: string }>();
  for (const row of rows) {
    const link = (row.campaignAsset ?? {}) as Record<string, unknown>;
    const id = String(link.asset ?? "").split("/").pop() ?? "";
    links.set(id, { status: String(link.status ?? ""), resourceName: String(link.resourceName ?? "") });
  }
  return links;
}

// ── AI Max ───────────────────────────────────────────────────────────

/** Origem de um termo de pesquisa (segments.search_term_match_source, v25). */
export const SEARCH_TERM_MATCH_SOURCES = [
  "ADVERTISER_PROVIDED_KEYWORD",
  "AI_MAX_KEYWORDLESS",
  "AI_MAX_BROAD_MATCH",
  "DYNAMIC_SEARCH_ADS",
  "PERFORMANCE_MAX",
  "VERTICAL_ADS_DATA_FEED",
] as const;
export const AI_MAX_MATCH_SOURCES = ["AI_MAX_KEYWORDLESS", "AI_MAX_BROAD_MATCH"];

/** Limites de text_guidelines documentados no proto da Campaign (v25). */
export const MAX_TERM_EXCLUSIONS = 25;
export const MAX_TERM_EXCLUSION_CHARS = 30;
export const MAX_MESSAGING_RESTRICTIONS = 40;
export const MAX_MESSAGING_RESTRICTION_CHARS = 300;

export const round2 = (value: number) => Math.round(value * 100) / 100;

/** Soma de métricas cruas; os derivados (CTR, CPC, CPA, ROAS) saem de metricsView. */
export interface MetricTotals {
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
}

export function emptyTotals(): MetricTotals {
  return { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionsValue: 0 };
}

export function addMetrics(totals: MetricTotals, metrics: Record<string, unknown> | undefined): MetricTotals {
  totals.impressions += num(metrics?.impressions);
  totals.clicks += num(metrics?.clicks);
  totals.costMicros += num(metrics?.costMicros);
  totals.conversions += num(metrics?.conversions);
  totals.conversionsValue += num(metrics?.conversionsValue);
  return totals;
}

export function metricsView(totals: MetricTotals) {
  const spend = totals.costMicros / 1_000_000;
  return {
    impressions: totals.impressions,
    clicks: totals.clicks,
    ctr_pct: totals.impressions ? round2((totals.clicks / totals.impressions) * 100) : 0,
    spend: round2(spend),
    cpc: totals.clicks ? round2(spend / totals.clicks) : null,
    conversions: round2(totals.conversions),
    cpa: totals.conversions ? round2(spend / totals.conversions) : null,
    conversions_value: round2(totals.conversionsValue),
    roas: spend ? round2(totals.conversionsValue / spend) : null,
  };
}

/** Rótulo de proporção pelas regras de imagem em Pesquisa (1:1 e 1.91:1). */
export function imageAspectLabel(width: number, height: number): string {
  if (!width || !height) return "desconhecida";
  const ratio = width / height;
  if (Math.abs(ratio - 1) <= 0.01) return "1:1 (quadrada)";
  if (Math.abs(ratio - 1.91) <= 0.02) return "1.91:1 (paisagem)";
  return `${ratio.toFixed(2)}:1 (fora de 1:1 e 1.91:1)`;
}

/**
 * Distribui o partialFailureError da API pelas operações recusadas. Cada erro
 * traz location.fieldPathElements com { fieldName: "operations", index }.
 */
export function partialFailureByOperation(
  partialError: unknown,
  operationCount: number
): { byIndex: Map<number, string[]>; unattributed: string[] } {
  const byIndex = new Map<number, string[]>();
  const unattributed: string[] = [];
  if (!partialError || typeof partialError !== "object") return { byIndex, unattributed };
  const failure = partialError as Record<string, unknown>;
  let sawDetail = false;
  for (const detail of (failure.details as Array<Record<string, unknown>>) ?? []) {
    for (const err of (detail.errors as Array<Record<string, unknown>>) ?? []) {
      sawDetail = true;
      const codes = Object.entries((err.errorCode as Record<string, unknown>) ?? {}).map(([k, v]) => `${k}.${v}`);
      const message = `${String(err.message ?? "erro sem mensagem")}${codes.length ? ` [${codes.join(", ")}]` : ""}`;
      const path = ((err.location as Record<string, unknown>)?.fieldPathElements as Array<Record<string, unknown>>) ?? [];
      const op = path.find((el) => el.fieldName === "operations");
      let index = op && op.index !== undefined ? Number(op.index) : NaN;
      if (Number.isNaN(index) && operationCount === 1) index = 0;
      if (Number.isInteger(index) && index >= 0 && index < operationCount) {
        byIndex.set(index, [...(byIndex.get(index) ?? []), message]);
      } else {
        unattributed.push(message);
      }
    }
  }
  if (!sawDetail) unattributed.push(String(failure.message ?? formatJson(failure)));
  return { byIndex, unattributed };
}

export function checkCustomerAccess(
  customerId: string,
  allowedIds: string[],
  hosted: boolean
): ReturnType<typeof text> | null {
  /* Defence in depth, but only where a network surface exists. On a hosted run
     (port > 0) startup already refuses an empty allowlist, and denying here too
     keeps any future path that skipped that gate closed rather than wide open.
     On stdio the client spawns this process with its own credential and no
     allowlist is expected, so an empty list keeps its original meaning of "no
     filter" — otherwise every tool would deny on a normal local setup. */
  if (allowedIds.length === 0) {
    if (!hosted) return null;
    return {
      type: "text" as const,
      text: "Access denied: no customer allowlist is configured.",
    };
  }
  // Curinga explícito: serve todo o MCC (modo agência). Só chega aqui quando o
  // operador escreveu "*", nunca por omissão.
  if (allowedIds.includes("*")) return null;
  const cid = customerId.replace(/-/g, "");
  if (!allowedIds.some((allowedId) => allowedId.replace(/-/g, "") === cid)) {
    return {
      type: "text" as const,
      text: `Access denied: customer ${customerId} not in allowed list.`,
    };
  }
  return null;
}

/**
 * Dimensões de listing group na v25 (oneof ListingGroupFilterDimension).
 * `valueField` diz em qual campo o valor entra; `fixed` são os campos que a API
 * exige junto — e que continuam valendo no nó "everything else", que vai sem
 * valor mas com o mesmo level/index dos irmãos.
 */
export const LISTING_GROUP_DIMENSIONS: Record<string, {
  key: string;
  valueField: "value" | "categoryId" | "channel";
  fixed?: Record<string, string>;
}> = {
  PRODUCT_BRAND: { key: "productBrand", valueField: "value" },
  PRODUCT_ITEM_ID: { key: "productItemId", valueField: "value" },
  PRODUCT_CHANNEL: { key: "productChannel", valueField: "channel" },
  PRODUCT_CATEGORY_LEVEL1: { key: "productCategory", valueField: "categoryId", fixed: { level: "LEVEL1" } },
  PRODUCT_CATEGORY_LEVEL2: { key: "productCategory", valueField: "categoryId", fixed: { level: "LEVEL2" } },
  PRODUCT_CATEGORY_LEVEL3: { key: "productCategory", valueField: "categoryId", fixed: { level: "LEVEL3" } },
  PRODUCT_CATEGORY_LEVEL4: { key: "productCategory", valueField: "categoryId", fixed: { level: "LEVEL4" } },
  PRODUCT_CATEGORY_LEVEL5: { key: "productCategory", valueField: "categoryId", fixed: { level: "LEVEL5" } },
  PRODUCT_TYPE_LEVEL1: { key: "productType", valueField: "value", fixed: { level: "LEVEL1" } },
  PRODUCT_TYPE_LEVEL2: { key: "productType", valueField: "value", fixed: { level: "LEVEL2" } },
  PRODUCT_TYPE_LEVEL3: { key: "productType", valueField: "value", fixed: { level: "LEVEL3" } },
  PRODUCT_TYPE_LEVEL4: { key: "productType", valueField: "value", fixed: { level: "LEVEL4" } },
  PRODUCT_TYPE_LEVEL5: { key: "productType", valueField: "value", fixed: { level: "LEVEL5" } },
  PRODUCT_CUSTOM_ATTRIBUTE0: { key: "productCustomAttribute", valueField: "value", fixed: { index: "INDEX0" } },
  PRODUCT_CUSTOM_ATTRIBUTE1: { key: "productCustomAttribute", valueField: "value", fixed: { index: "INDEX1" } },
  PRODUCT_CUSTOM_ATTRIBUTE2: { key: "productCustomAttribute", valueField: "value", fixed: { index: "INDEX2" } },
  PRODUCT_CUSTOM_ATTRIBUTE3: { key: "productCustomAttribute", valueField: "value", fixed: { index: "INDEX3" } },
  PRODUCT_CUSTOM_ATTRIBUTE4: { key: "productCustomAttribute", valueField: "value", fixed: { index: "INDEX4" } },
};

/**
 * Monta o case_value (ListingGroupFilterDimension) da v25.
 * value === undefined → nó "everything else": mesma dimensão dos irmãos,
 * com level/index e sem valor. Nó sem case_value a API lê como raiz
 * ("Each Listing Group tree must have a single root").
 */
export function buildListingGroupCaseValue(dimension: string, value?: string): Record<string, unknown> {
  const spec = LISTING_GROUP_DIMENSIONS[dimension];
  if (!spec) {
    throw new Error(
      `Dimensão de listing group inválida: "${dimension}". Válidas: ${Object.keys(LISTING_GROUP_DIMENSIONS).join(", ")}.`
    );
  }
  const dim: Record<string, unknown> = { ...(spec.fixed ?? {}) };
  if (value !== undefined) {
    if (spec.valueField === "categoryId") {
      // categoryId é int64 (ID do product_category_constant), não o nome da categoria.
      const id = value.trim();
      if (!/^\d+$/.test(id)) {
        throw new Error(
          `${dimension} exige o categoryId numérico (SELECT product_category_constant.category_id FROM product_category_constant), recebido "${value}".`
        );
      }
      dim.categoryId = id;
    } else if (spec.valueField === "channel") {
      const channel = value.trim().toUpperCase();
      if (channel !== "ONLINE" && channel !== "LOCAL") {
        throw new Error(`PRODUCT_CHANNEL aceita apenas ONLINE ou LOCAL, recebido "${value}".`);
      }
      dim.channel = channel;
    } else {
      dim.value = value;
    }
  }
  return { [spec.key]: dim };
}

/** Declaração obrigatória de propaganda política na UE (enum EuPoliticalAdvertisingStatus). */
export const EU_POLITICAL_DECLARATION = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";

// ── Conversion actions (validado contra a API v25) ───────────────────

/** Categorias válidas de ConversionActionCategory na API atual. */
export const CONVERSION_CATEGORIES = [
  "DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART",
  "BEGIN_CHECKOUT", "SUBSCRIBE_PAID", "PHONE_CALL_LEAD", "IMPORTED_LEAD",
  "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT", "REQUEST_QUOTE", "GET_DIRECTIONS",
  "OUTBOUND_CLICK", "CONTACT", "ENGAGEMENT", "STORE_VISIT", "STORE_SALE",
  "QUALIFIED_LEAD", "CONVERTED_LEAD",
] as const;

/** Nomes antigos/amigáveis que a API não aceita mais — traduzidos antes do mutate. */
export const CONVERSION_CATEGORY_ALIASES: Record<string, string> = {
  LEAD: "SUBMIT_LEAD_FORM", // LEAD foi removido da API
  SIGN_UP: "SIGNUP",        // a API escreve sem underscore
};

/** Tipos de conversão criáveis via API + apelidos amigáveis. */
export const CONVERSION_TYPE_ALIASES: Record<string, string> = {
  UPLOAD: "UPLOAD_CLICKS",   // UPLOAD não existe no enum
  PHONE_CALL: "WEBSITE_CALL", // chamadas a partir do número no site
};

/**
 * Modelos de atribuição: nomes amigáveis → nomes reais do enum AttributionModel.
 * Só DATA_DRIVEN e LAST_CLICK sao settable: o Google desligou os modelos baseados
 * em regras (first click, linear, time decay, position based) em 2023 — o enum
 * ainda os lista, mas a API recusa grava-los.
 */
export const ATTRIBUTION_MODEL_ALIASES: Record<string, string> = {
  DATA_DRIVEN: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
  LAST_CLICK: "GOOGLE_ADS_LAST_CLICK",
};

export const conversionCategorySchema = z.enum([
  ...CONVERSION_CATEGORIES,
  "LEAD",
  "SIGN_UP",
]);

export const conversionTypeSchema = z.enum([
  "WEBPAGE", "UPLOAD", "UPLOAD_CLICKS", "UPLOAD_CALLS",
  "PHONE_CALL", "WEBSITE_CALL", "AD_CALL", "CLICK_TO_CALL",
]);

export const attributionModelSchema = z.enum([
  "DATA_DRIVEN", "LAST_CLICK",
  "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN", "GOOGLE_ADS_LAST_CLICK",
]);

/** Resolve apelido → valor aceito pela API. */
export function resolveEnumAlias(value: string, aliases: Record<string, string>): string {
  return aliases[value] ?? value;
}

// ── Telefone E.164 (conversões offline, chamadas, Customer Match) ─────

/**
 * Tamanhos do número nacional (sem DDI e sem o 0 de tronco) nos planos de numeração que o
 * módulo conhece. É o que separa "5511999998888" (DDI 55 já incluído, sem "+") de um número
 * nacional: no Brasil, DDD + 8 ou 9 dígitos = 10 ou 11; com o DDI, 12 ou 13.
 * - 55 (Brasil): DDD de 2 dígitos + 8 (fixo) ou 9 (celular).
 * - 1 (NANP — EUA/Canadá): código de área + 7 dígitos = 10.
 * - 351 (Portugal): 9 dígitos.
 */
const NATIONAL_NUMBER_LENGTHS: Record<string, number[]> = {
  "55": [10, 11],
  "1": [10],
  "351": [9],
};

const PLUS_DDI_HELP = (cc: string) => `use E.164 com "+" (ex.: +${cc}…)`;

/**
 * Número sem "+"/"00" com defaultCountryCode. Um número que já traz o DDI sem "+" não pode
 * ganhar o DDI de novo: "+555511999998888" tem 15 dígitos, passa na regex E.164 e, depois do
 * hash, a API não tem como avisar — o enhancement/lead/chamada simplesmente não casa.
 * Nos planos conhecidos o tamanho decide; nos outros, número que começa com o DDI é ambíguo
 * e é recusado (número nacional escrito com o 0 de tronco nunca começa pelo DDI).
 */
function applyDefaultCountryCode(digits: string, cc: string): { value: string } | { error: string } {
  const trunkPrefix = digits.startsWith("0");
  const national = digits.replace(/^0+/, "");
  const startsWithCc = !trunkPrefix && national.startsWith(cc);
  const lengths = NATIONAL_NUMBER_LENGTHS[cc];
  if (lengths) {
    const asNational = lengths.includes(national.length);
    const asInternational = startsWithCc && lengths.includes(national.length - cc.length);
    if (asNational && asInternational) {
      return { error: `telefone ambíguo: pode já ter o DDI ${cc} ou não — ${PLUS_DDI_HELP(cc)}` };
    }
    if (asInternational) return { value: `+${national}` };
    if (asNational) return { value: `+${cc}${national}` };
    return {
      error: `telefone com ${national.length} dígito(s): não é número nacional do DDI ${cc} (${lengths.join(" ou ")} dígitos` +
        `${cc === "55" ? ", com DDD" : ""}) nem já tem o DDI ${cc} — ${PLUS_DDI_HELP(cc)}`,
    };
  }
  if (startsWithCc) {
    return { error: `telefone começa com ${cc} (o DDI padrão) e não tem "+": não dá para saber se o DDI já está incluído — ${PLUS_DDI_HELP(cc)}` };
  }
  return { value: `+${cc}${national}` };
}

/**
 * Telefone em E.164 (+5511999998888). Sem "+" (ou "00") no início, só com
 * defaultCountryCode — número nacional sem DDI viraria um E.164 errado que a regex aceita.
 * Número que já traz o DDI sem "+" (ex.: "5511999998888" do CRM) não ganha o DDI de novo.
 */
export function normalizePhone(raw: string, defaultCountryCode?: string): { value: string } | { error: string } {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (trimmed.startsWith("00")) e164 = `+${digits.slice(2)}`;
  else if (defaultCountryCode) {
    const withCc = applyDefaultCountryCode(digits, defaultCountryCode);
    if ("error" in withCc) return withCc;
    e164 = withCc.value;
  } else return { error: "telefone sem código do país — use E.164 (+5511999998888) ou informe defaultPhoneCountryCode (ex.: \"55\")" };
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return { error: "telefone não forma um E.164 válido (+ DDI + número, 7 a 15 dígitos)" };
  return { value: e164 };
}
