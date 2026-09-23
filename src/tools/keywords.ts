/**
 * Lote keywords: Palavras-chave, termos de pesquisa e DSA.
 *
 * Tools novas:
 * - list_keywords (leitura): palavras-chave com IDs, status e motivos, componentes do
 *   Índice de Qualidade, lances e estimativas de primeira página — inclusive as sem impressão;
 * - add_keywords (escrita): várias palavras-chave num grupo, com partialFailure, validação de
 *   tamanho e sem duplicar o que já existe;
 * - bulk_update_keyword_status (escrita): pausa/ativa palavras-chave em lote;
 * - get_search_term_insights (leitura): categorias de pesquisa com volume (Search e PMax);
 * - audit_dsa_and_legacy (leitura): inventário de DSA e da migração para AI Max.
 *
 * Os helpers exportados (addKeywordsToAdGroup, keywordDiagnostics) também servem às tools do
 * núcleo create_keyword e get_keyword_performance, em src/tools.ts.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  LOW_BID_MICROS,
  MANUAL_BID_STRATEGIES,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  isPositiveMicros,
  microsToMoney,
  money,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const NUMERIC_ID = /^\d+$/;

/** Limites do KeywordInfo.text (proto common/criteria.proto da v25: "at most 80 characters and 10 words"). */
export const KEYWORD_MAX_CHARS = 80;
export const KEYWORD_MAX_WORDS = 10;
/** Teto do servidor por chamada (a API aceita até 10.000 operações por mutate). */
export const MAX_KEYWORDS_PER_CALL = 1000;
/** audit_dsa_and_legacy: termos de DSA lidos (os de maior custo) e teto da soma por página. */
export const DSA_TOP_TERMS_SCAN = 1000;
export const DSA_PAGE_SCAN_CAP = 50_000;
/** Acima disso, mudar status em lote exige confirm: true. */
export const BULK_STATUS_CONFIRM_THRESHOLD = 20;
export const KEYWORD_MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
/** Tipos de grupo que aceitam palavra-chave positiva. SEARCH_DYNAMIC_ADS não aceita (guia de DSA). */
const KEYWORD_AD_GROUP_TYPES = new Set(["SEARCH_STANDARD", "DISPLAY_STANDARD"]);

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const DRY_RUN_NOTE = "DRY-RUN (validateOnly): validado, nada foi gravado.";

function parseLimit(value: unknown, fallback: number, max: number, label = "limit"): number | string {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return `${label} deve ser inteiro positivo (recebido ${String(value)}).`;
  }
  return Math.min(value, max);
}

function renderRows(rows: Row[], format: string | undefined): string {
  const flat = rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Array.isArray(v) ? v.join(" | ") : v]))
  );
  if (format === "table") return formatAsTable(flat);
  if (format === "csv") return formatAsCsv(flat);
  return formatJson(rows);
}

// ── Palavras-chave: validação ─────────────────────────────────────────

/** Texto como a API compara (sem diferença de caixa nem espaços repetidos). */
export function normalizeKeywordText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Problema no texto da palavra-chave, ou null. Recusa antes de chegar à API. */
export function keywordTextProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "texto ausente";
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return "texto vazio";
  if (/^\[.*\]$/.test(value) || /^".*"$/.test(value)) {
    return "não use colchetes/aspas para indicar a correspondência — informe matchType (EXACT, PHRASE ou BROAD)";
  }
  if (/(^|\s)\+\S/.test(value)) {
    return "o modificador de ampla (+palavra) não existe mais (BROAD_MATCH_MODIFIER_KEYWORD_NOT_ALLOWED) — use BROAD ou PHRASE";
  }
  if (value.startsWith("-")) return "negativa não entra aqui — use add_negative_keyword";
  if (value.length > KEYWORD_MAX_CHARS) return `tem ${value.length} caracteres (máximo ${KEYWORD_MAX_CHARS})`;
  const words = value.split(" ").length;
  if (words > KEYWORD_MAX_WORDS) return `tem ${words} palavras (máximo ${KEYWORD_MAX_WORDS})`;
  return null;
}

// ── Palavras-chave: diagnóstico ───────────────────────────────────────

/**
 * Motivos de primary_status que viram código de fix em keywordDiagnostics (enum
 * AdGroupCriterionPrimaryStatusReason da v25). Um teste confere que esta lista e o diagnóstico
 * andam juntos — as consultas dirigidas do onlyIssues dependem dela.
 */
export const ISSUE_STATUS_REASONS = [
  "AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID",
  "AD_GROUP_CRITERION_RARELY_SERVED",
  "AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY",
  "AD_GROUP_CRITERION_DISAPPROVED",
  "AD_GROUP_CRITERION_RESTRICTED",
  "CAMPAIGN_CRITERION_NEGATIVE",
  "AD_GROUP_CRITERION_LOW_QUALITY",
] as const;

/** Teto de linhas da varredura do onlyIssues e de cada consulta dirigida. */
export const ISSUE_SCAN_CAP = 10_000;

/**
 * Condições GAQL que trazem as candidatas de cada código de fix. GAQL não tem OR: quando a
 * varredura da conta passa do teto, cada condição vira uma consulta, e o teto passa a valer
 * para as candidatas, não para a conta inteira. Juntas cobrem todos os ramos de
 * keywordDiagnostics (o diagnóstico final continua lá).
 */
export const ISSUE_CANDIDATE_QUERIES: ReadonlyArray<{ check: string; where: string }> = [
  { check: "LP (experiência na página)", where: "ad_group_criterion.quality_info.post_click_quality_score = 'BELOW_AVERAGE'" },
  { check: "AD (relevância do anúncio)", where: "ad_group_criterion.quality_info.creative_quality_score = 'BELOW_AVERAGE'" },
  { check: "CTR (CTR esperada)", where: "ad_group_criterion.quality_info.search_predicted_ctr = 'BELOW_AVERAGE'" },
  {
    check: "motivos de status (BID, VOLUME, POLICY, NEGATIVE, QS)",
    where: `ad_group_criterion.primary_status_reasons CONTAINS ANY (${ISSUE_STATUS_REASONS.map((r) => `'${r}'`).join(", ")})`,
  },
  { check: "VOLUME (raramente veiculada)", where: "ad_group_criterion.system_serving_status = 'RARELY_SERVED'" },
  { check: "POLICY (reprovada)", where: "ad_group_criterion.approval_status = 'DISAPPROVED'" },
  {
    check: "BID (CPC manual abaixo da 1ª página)",
    where:
      `campaign.bidding_strategy_type IN (${[...MANUAL_BID_STRATEGIES].map((s) => `'${s}'`).join(", ")})\n` +
      "           AND ad_group_criterion.position_estimates.first_page_cpc_micros > 0",
  },
];

/**
 * Traduz status, motivos, componentes do Índice de Qualidade e estimativas de lance em
 * códigos de ação: LP (página de destino), AD (relevância do anúncio), CTR (CTR esperada),
 * BID (abaixo da 1ª página), VOLUME (pouco volume), POLICY, NEGATIVE, QS.
 */
export function keywordDiagnostics(criterion: Row, biddingStrategyType?: string): { fix: string[]; notes: string[] } {
  const fix: string[] = [];
  const notes: string[] = [];
  const add = (code: string, note: string) => {
    if (!fix.includes(code)) fix.push(code);
    notes.push(note);
  };
  const quality = obj(criterion.qualityInfo);
  const reasons = ((criterion.primaryStatusReasons as string[] | undefined) ?? []).map(String);
  const estimates = obj(criterion.positionEstimates);
  // Ao mexer nos motivos abaixo, atualize ISSUE_STATUS_REASONS (consultas dirigidas do onlyIssues).

  if (quality.postClickQualityScore === "BELOW_AVERAGE") {
    add("LP", "Experiência na página de destino abaixo da média: revise relevância, velocidade e mobile da LP, ou use uma finalUrl mais específica.");
  }
  if (quality.creativeQualityScore === "BELOW_AVERAGE") {
    add("AD", "Relevância do anúncio abaixo da média: leve o termo aos títulos ou mova a palavra-chave para um grupo mais específico.");
  }
  if (quality.searchPredictedCtr === "BELOW_AVERAGE") {
    add("CTR", "CTR esperada abaixo da média: o anúncio atrai pouco para esse termo (oferta, chamada, correspondência).");
  }
  const effective = num(criterion.effectiveCpcBidMicros);
  const firstPage = num(estimates.firstPageCpcMicros);
  const manual = biddingStrategyType ? MANUAL_BID_STRATEGIES.has(biddingStrategyType) : false;
  if (reasons.includes("AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID") || (manual && effective > 0 && firstPage > effective)) {
    add("BID", `Lance abaixo do estimado para a primeira página${firstPage ? ` (estimativa ${money(firstPage)}, lance atual ${money(effective)})` : ""}.`);
  }
  if (criterion.systemServingStatus === "RARELY_SERVED" || reasons.includes("AD_GROUP_CRITERION_RARELY_SERVED")) {
    add("VOLUME", "Pouco volume de pesquisa (raramente veiculada): amplie a correspondência ou consolide com outra palavra-chave.");
  }
  if (reasons.includes("AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY")) {
    add("VOLUME", "Pausada pelo Google por baixa atividade prolongada.");
  }
  if (
    criterion.approvalStatus === "DISAPPROVED" ||
    reasons.includes("AD_GROUP_CRITERION_DISAPPROVED") ||
    reasons.includes("AD_GROUP_CRITERION_RESTRICTED")
  ) {
    add("POLICY", "Reprovada ou restrita por política: veja o motivo na interface ou peça exceção.");
  }
  if (reasons.includes("CAMPAIGN_CRITERION_NEGATIVE")) {
    add("NEGATIVE", "Bloqueada por uma palavra-chave negativa da campanha.");
  }
  if (reasons.includes("AD_GROUP_CRITERION_LOW_QUALITY") && !fix.some((code) => code === "LP" || code === "AD" || code === "CTR")) {
    add("QS", "Índice de Qualidade baixo.");
  }
  return { fix, notes };
}

/** Linha de palavra-chave (ad_group_criterion + ad_group + campaign) no formato das tools. */
export function keywordView(row: Row, diagnostics: boolean): Row {
  const criterion = obj(row.adGroupCriterion);
  const keyword = obj(criterion.keyword);
  const quality = obj(criterion.qualityInfo);
  const adGroup = obj(row.adGroup);
  const campaign = obj(row.campaign);
  const view: Row = {
    criterion_id: String(criterion.criterionId ?? ""),
    ad_group_id: String(adGroup.id ?? ""),
    campaign_id: String(campaign.id ?? ""),
    keyword: keyword.text,
    match_type: keyword.matchType,
    campaign: campaign.name,
    ad_group: adGroup.name,
    status: criterion.status,
    quality_score: quality.qualityScore ?? null,
  };
  if (!diagnostics) return view;
  const estimates = obj(criterion.positionEstimates);
  const strategy = campaign.biddingStrategyType === undefined ? undefined : String(campaign.biddingStrategyType);
  const { fix, notes } = keywordDiagnostics(criterion, strategy);
  return {
    ...view,
    negative: criterion.negative === true,
    primary_status: criterion.primaryStatus ?? null,
    primary_status_reasons: (criterion.primaryStatusReasons as string[] | undefined) ?? [],
    approval_status: criterion.approvalStatus ?? null,
    serving_status: criterion.systemServingStatus ?? null,
    ad_relevance: quality.creativeQualityScore ?? null,
    landing_page_experience: quality.postClickQualityScore ?? null,
    expected_ctr: quality.searchPredictedCtr ?? null,
    cpc_bid: criterion.cpcBidMicros === undefined ? null : round2(microsToMoney(criterion.cpcBidMicros)),
    effective_cpc_bid: criterion.effectiveCpcBidMicros === undefined ? null : round2(microsToMoney(criterion.effectiveCpcBidMicros)),
    first_page_cpc: estimates.firstPageCpcMicros === undefined ? null : round2(microsToMoney(estimates.firstPageCpcMicros)),
    top_of_page_cpc: estimates.topOfPageCpcMicros === undefined ? null : round2(microsToMoney(estimates.topOfPageCpcMicros)),
    first_position_cpc: estimates.firstPositionCpcMicros === undefined ? null : round2(microsToMoney(estimates.firstPositionCpcMicros)),
    bidding_strategy: strategy ?? null,
    final_urls: (criterion.finalUrls as string[] | undefined) ?? [],
    fix,
    diagnosis: notes,
  };
}

/** Campos de ad_group_criterion que o diagnóstico usa (keyword_view e ad_group_criterion). */
export const KEYWORD_DIAGNOSTIC_FIELDS = [
  "ad_group_criterion.negative",
  "ad_group_criterion.primary_status",
  "ad_group_criterion.primary_status_reasons",
  "ad_group_criterion.approval_status",
  "ad_group_criterion.system_serving_status",
  "ad_group_criterion.quality_info.creative_quality_score",
  "ad_group_criterion.quality_info.post_click_quality_score",
  "ad_group_criterion.quality_info.search_predicted_ctr",
  "ad_group_criterion.cpc_bid_micros",
  "ad_group_criterion.effective_cpc_bid_micros",
  "ad_group_criterion.position_estimates.first_page_cpc_micros",
  "ad_group_criterion.position_estimates.top_of_page_cpc_micros",
  "ad_group_criterion.position_estimates.first_position_cpc_micros",
  "ad_group_criterion.final_urls",
  "campaign.bidding_strategy_type",
];

// ── Palavras-chave: criação (add_keywords e create_keyword) ──────────

export interface KeywordInput {
  text: string;
  matchType: string;
  cpcBidMicros?: number;
  finalUrl?: string;
}

/**
 * Cria palavras-chave num grupo de anúncios: valida tudo antes da API, confere o grupo,
 * pula o que já existe (inclusive pausada — nunca reativa em silêncio) e as repetidas no
 * pedido, e grava com partialFailure, relatando cada item.
 */
export async function addKeywordsToAdGroup(
  client: GoogleAdsClient,
  customerId: string,
  adGroupId: string,
  rawItems: unknown[],
  options: { status?: "ENABLED" | "PAUSED" } = {}
): Promise<ToolResult> {
  if (!NUMERIC_ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi criado.`);
  if (rawItems.length === 0) return fail("Informe ao menos uma palavra-chave. Nada foi criado.");
  if (rawItems.length > MAX_KEYWORDS_PER_CALL) {
    return fail(`Máximo de ${MAX_KEYWORDS_PER_CALL} palavras-chave por chamada (recebidas ${rawItems.length}). Divida em lotes. Nada foi criado.`);
  }

  const problems: string[] = [];
  const items: KeywordInput[] = [];
  rawItems.forEach((raw, index) => {
    const item = obj(raw);
    const label = `#${index + 1} "${String(item.text ?? "")}"`;
    const issues: string[] = [];
    const textIssue = keywordTextProblem(item.text);
    if (textIssue) issues.push(textIssue);
    const matchType = String(item.matchType ?? "").toUpperCase();
    if (!(KEYWORD_MATCH_TYPES as readonly string[]).includes(matchType)) {
      issues.push(`matchType inválido "${String(item.matchType ?? "")}" (use EXACT, PHRASE ou BROAD)`);
    }
    if (item.cpcBidMicros !== undefined && !isPositiveMicros(item.cpcBidMicros)) {
      issues.push(`cpcBidMicros deve ser inteiro positivo em micros (recebido ${String(item.cpcBidMicros)})`);
    }
    const url = item.finalUrl === undefined ? undefined : String(item.finalUrl).trim();
    if (url !== undefined && url !== "" && !/^https?:\/\/\S+$/i.test(url)) {
      issues.push(`finalUrl inválida "${String(item.finalUrl)}" (use uma URL http(s) completa)`);
    }
    if (issues.length) {
      problems.push(`${label}: ${issues.join("; ")}`);
      return;
    }
    items.push({
      text: String(item.text).trim().replace(/\s+/g, " "),
      matchType,
      cpcBidMicros: item.cpcBidMicros as number | undefined,
      finalUrl: url || undefined,
    });
  });
  if (problems.length) {
    return fail(`Nada foi criado — corrija antes de reenviar:\n- ${problems.join("\n- ")}`);
  }

  const groupRows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
            campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.bidding_strategy_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  const adGroup = obj(groupRows[0]?.adGroup);
  const campaign = obj(groupRows[0]?.campaign);
  if (!adGroup.id) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${customerId}. Nada foi criado.`);
  if (adGroup.status === "REMOVED" || campaign.status === "REMOVED") {
    return fail(`O grupo ${adGroupId} (ou a campanha dele) está removido. Nada foi criado.`);
  }
  const groupType = String(adGroup.type ?? "");
  if (groupType === "SEARCH_DYNAMIC_ADS") {
    return fail(`O grupo ${adGroupId} é de Anúncios Dinâmicos de Pesquisa (SEARCH_DYNAMIC_ADS): esse tipo não aceita palavras-chave positivas. Nada foi criado.`);
  }
  if (groupType && !KEYWORD_AD_GROUP_TYPES.has(groupType)) {
    return fail(`O grupo ${adGroupId} é do tipo ${groupType}, que não usa palavras-chave de pesquisa. Nada foi criado.`);
  }

  const existingRows = await client.searchStream(customerId,
    `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type, ad_group_criterion.status,
            ad_group_criterion.negative
     FROM ad_group_criterion
     WHERE ad_group.id = ${adGroupId}
       AND ad_group_criterion.type = 'KEYWORD'
       AND ad_group_criterion.status != 'REMOVED'`);
  const existing = new Map<string, Row>();
  const negatives = new Set<string>();
  for (const row of existingRows) {
    const criterion = obj(row.adGroupCriterion);
    const keyword = obj(criterion.keyword);
    const norm = normalizeKeywordText(String(keyword.text ?? ""));
    if (criterion.negative === true) negatives.add(norm);
    else existing.set(`${norm}|${String(keyword.matchType ?? "")}`, criterion);
  }

  const skippedExisting: Row[] = [];
  const skippedDuplicates: Row[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const toCreate: KeywordInput[] = [];
  for (const item of items) {
    const norm = normalizeKeywordText(item.text);
    const key = `${norm}|${item.matchType}`;
    const found = existing.get(key);
    if (found) {
      skippedExisting.push({
        keyword: item.text, match_type: item.matchType, criterion_id: String(found.criterionId ?? ""), status: found.status,
        note: found.status === "PAUSED" ? "já existe PAUSADA — não foi reativada (use update_keyword ou bulk_update_keyword_status)" : "já existe",
      });
      continue;
    }
    if (seen.has(key)) {
      skippedDuplicates.push({ keyword: item.text, match_type: item.matchType });
      continue;
    }
    seen.add(key);
    if (negatives.has(norm)) warnings.push(`"${item.text}" também é negativa neste grupo: a negativa bloqueia a positiva.`);
    toCreate.push(item);
  }

  const strategy = String(campaign.biddingStrategyType ?? "");
  const withBid = toCreate.filter((item) => item.cpcBidMicros !== undefined);
  if (withBid.length && strategy && !MANUAL_BID_STRATEGIES.has(strategy)) {
    warnings.push(`A campanha usa ${strategy}: o lance automático ignora o cpcBidMicros das palavras-chave.`);
  }
  for (const item of withBid) {
    if ((item.cpcBidMicros ?? 0) < LOW_BID_MICROS) warnings.push(`"${item.text}": lance muito baixo (${money(item.cpcBidMicros)}).`);
  }
  if (groupType === "DISPLAY_STANDARD") warnings.push("Grupo de Display: palavras-chave aqui são de conteúdo (segmentação contextual), não de pesquisa.");
  if (adGroup.status === "PAUSED" || campaign.status === "PAUSED") {
    warnings.push("O grupo ou a campanha está pausado: as palavras-chave novas não veiculam até reativar.");
  }

  const cid = customerId.replace(/-/g, "");
  const status = options.status ?? "ENABLED";
  const summary: Row = {
    ad_group: { id: String(adGroup.id), name: adGroup.name, type: groupType || null, campaign_id: String(campaign.id ?? ""), campaign: campaign.name },
  };
  if (toCreate.length === 0) {
    return {
      content: [text(
        `Nenhuma palavra-chave nova — todas já existem no grupo ou se repetem no pedido. Nenhuma escrita foi enviada.\n\n` +
        formatJson({ ...summary, skipped_existing: skippedExisting, skipped_duplicates_in_request: skippedDuplicates, warnings })
      )],
    };
  }

  const operations = toCreate.map((item) => ({
    create: {
      adGroup: `customers/${cid}/adGroups/${adGroupId}`,
      status,
      keyword: { text: item.text, matchType: item.matchType },
      ...(item.cpcBidMicros !== undefined ? { cpcBidMicros: String(item.cpcBidMicros) } : {}),
      ...(item.finalUrl ? { finalUrls: [item.finalUrl] } : {}),
    },
  }));
  const result = await client.mutate(customerId, "adGroupCriteria", operations, { partialFailure: true });
  const dryRun = client.isDryRun;
  const { byIndex, unattributed } = partialFailureByOperation(result.partialFailureError, operations.length);
  const results = (result.results as Row[] | undefined) ?? [];
  const created: Row[] = [];
  const errors: Row[] = [];
  toCreate.forEach((item, index) => {
    const describe = { keyword: item.text, match_type: item.matchType };
    const itemErrors = byIndex.get(index);
    if (itemErrors) {
      errors.push({ ...describe, error: itemErrors.join("; ") });
      return;
    }
    const resourceName = String(results[index]?.resourceName ?? "");
    if (dryRun) {
      created.push({ ...describe, status });
    } else if (resourceName) {
      created.push({ ...describe, status, criterion_id: resourceName.split("~").pop(), resource_name: resourceName });
    } else {
      errors.push({ ...describe, error: "a API não confirmou a criação" });
    }
  });
  const payload = {
    ...summary,
    [dryRun ? "validated" : "created"]: created,
    skipped_existing: skippedExisting,
    skipped_duplicates_in_request: skippedDuplicates,
    errors,
    ...(unattributed.length ? { unattributed_errors: unattributed } : {}),
    warnings,
  };
  const head = dryRun
    ? `${DRY_RUN_NOTE} ${created.length} de ${toCreate.length} palavra(s)-chave passariam.`
    : `${created.length} de ${toCreate.length} palavra(s)-chave criada(s) no grupo ${adGroupId} (${status}).`;
  return {
    content: [text(`${head}${errors.length ? ` ${errors.length} recusada(s) — veja errors.` : ""}\n\n${formatJson(payload)}`)],
    ...(errors.length || unattributed.length ? { isError: true } : {}),
  };
}

// ── Search term insights ──────────────────────────────────────────────

const RESOURCE_EXHAUSTED = /RESOURCE_EXHAUSTED|RESOURCE_TEMPORARILY_EXHAUSTED|resource has been exhausted|too many requests/i;

function volumeRange(metrics: Row): { search_volume: string | null; search_volume_min: number | null; search_volume_max: number | null } {
  const range = obj(metrics.searchVolume);
  const min = range.min === undefined ? null : num(range.min);
  const max = range.max === undefined ? null : num(range.max);
  if (min === null && max === null) return { search_volume: null, search_volume_min: null, search_volume_max: null };
  return { search_volume: `${min ?? "?"}–${max ?? "+"}`, search_volume_min: min, search_volume_max: max };
}

// ── Registro ──────────────────────────────────────────────────────────

export function registerKeywordsTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── list_keywords ───────────────────────────────────────────────────

  mcp.registerTool(
    "list_keywords",
    {
      description: [
        "Lista as palavras-chave com os IDs necessários para update_keyword, remove_keyword e",
        "bulk_update_keyword_status — inclusive as que não tiveram impressão.",
        "",
        "Cada linha traz: criterion_id, ad_group_id, campaign_id, texto, correspondência, status,",
        "primary_status e motivos (ex.: AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID, RARELY_SERVED,",
        "PAUSED_DUE_TO_LOW_ACTIVITY), aprovação, Índice de Qualidade e componentes (relevância do",
        "anúncio, experiência na página, CTR esperada), lance, lance efetivo, estimativas de 1ª página /",
        "topo / 1ª posição, URL final e a coluna fix com o que corrigir: LP, AD, CTR, BID, VOLUME,",
        "POLICY, NEGATIVE, QS.",
        "",
        "includeMetrics=true soma impressões/cliques/custo/conversões do período (zeros para as sem tráfego).",
        "onlyIssues=true devolve só as que têm algum código em fix. Varre até 10.000 palavras-chave; se o",
        "filtro passar disso, busca por problema (uma consulta por condição) e summary.scan diz se a busca",
        "foi completa — se não foi, a resposta começa com ATENÇÃO e pede filtro por campanha/grupo.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha (ID numérico)."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (ID numérico)."),
        status: z.enum(["ALL", "ENABLED", "PAUSED"]).optional().describe("Status da palavra-chave. Default: ALL (menos as removidas)."),
        onlyIssues: z.boolean().optional().describe("true = só palavras-chave com diagnóstico (fix não vazio)."),
        includeNegatives: z.boolean().optional().describe("true = inclui as negativas do grupo. Default: false."),
        includeMetrics: z.boolean().optional().describe("true = inclui métricas do período (dateRange ou days)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máximo de linhas. Default: 500 (teto 10000)."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, status, onlyIssues, includeNegatives, includeMetrics, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (adGroupId !== undefined && !NUMERIC_ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      const max = parseLimit(limit, 500, 10_000);
      if (typeof max === "string") return fail(max);
      let dateClause = "";
      if (includeMetrics) {
        try {
          dateClause = buildDateClause(dateRange, days);
        } catch (err) {
          return fail((err as Error).message);
        }
      }

      const filters = [
        "ad_group_criterion.type = 'KEYWORD'",
        includeNegatives ? "" : "ad_group_criterion.negative = false",
        status === "ENABLED" || status === "PAUSED" ? `ad_group_criterion.status = '${status}'` : "ad_group_criterion.status != 'REMOVED'",
        "ad_group.status != 'REMOVED'",
        "campaign.status != 'REMOVED'",
        campaignId ? `campaign.id = ${campaignId}` : "",
        adGroupId ? `ad_group.id = ${adGroupId}` : "",
      ].filter(Boolean);
      const client = getClient();
      const fetchKeywords = (extra: string[], cap: number) =>
        client.searchStream(customerId,
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                  ad_group_criterion.quality_info.quality_score,
                  ${KEYWORD_DIAGNOSTIC_FIELDS.join(", ")},
                  ad_group.id, ad_group.name, ad_group.status,
                  campaign.id, campaign.name, campaign.status
           FROM ad_group_criterion
           WHERE ${[...filters, ...extra].join("\n           AND ")}
           ORDER BY campaign.name, ad_group.name, ad_group_criterion.keyword.text
           LIMIT ${cap}`);

      let rows: Row[];
      /** Só no onlyIssues: como a busca foi feita e se ela viu todas as candidatas. */
      let scan: { mode: "full" | "targeted"; complete: boolean; checked_rows: number; truncated_checks: string[] } | undefined;
      if (!onlyIssues) {
        rows = await fetchKeywords([], max);
      } else {
        // O filtro por fix é feito aqui, depois da API: a varredura precisa ver todas as palavras-chave.
        rows = await fetchKeywords([], ISSUE_SCAN_CAP);
        if (rows.length < ISSUE_SCAN_CAP) {
          scan = { mode: "full", complete: true, checked_rows: rows.length, truncated_checks: [] };
        } else {
          // Conta grande: a varredura parou no teto. Uma consulta por condição de problema, para que
          // o teto se aplique às candidatas; o que a varredura já trouxe entra na união.
          const keyOf = (row: Row) => `${String(obj(row.adGroup).id ?? "")}~${String(obj(row.adGroupCriterion).criterionId ?? "")}`;
          const byKey = new Map<string, Row>(rows.map((row) => [keyOf(row), row]));
          const results = await Promise.all(ISSUE_CANDIDATE_QUERIES.map((c) => fetchKeywords([c.where], ISSUE_SCAN_CAP)));
          const truncatedChecks: string[] = [];
          results.forEach((found, index) => {
            if (found.length >= ISSUE_SCAN_CAP) truncatedChecks.push(ISSUE_CANDIDATE_QUERIES[index].check);
            for (const row of found) byKey.set(keyOf(row), row);
          });
          const sortKey = (row: Row) => [obj(row.campaign).name, obj(row.adGroup).name, obj(obj(row.adGroupCriterion).keyword).text].map((v) => String(v ?? ""));
          rows = [...byKey.values()].sort((a, b) => {
            const [ka, kb] = [sortKey(a), sortKey(b)];
            return ka[0].localeCompare(kb[0], "pt-BR") || ka[1].localeCompare(kb[1], "pt-BR") || ka[2].localeCompare(kb[2], "pt-BR");
          });
          scan = { mode: "targeted", complete: truncatedChecks.length === 0, checked_rows: rows.length, truncated_checks: truncatedChecks };
        }
      }

      let keywords = rows.map((row) => keywordView(row, true));
      if (onlyIssues) keywords = keywords.filter((kw) => (kw.fix as string[]).length > 0);
      const matched = keywords.length;
      keywords = keywords.slice(0, max);

      if (includeMetrics && keywords.length) {
        const metricRows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group_criterion.criterion_id,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM keyword_view
           WHERE ${dateClause}
             AND ad_group_criterion.status != 'REMOVED'
             ${campaignId ? `AND campaign.id = ${campaignId}` : ""}
             ${adGroupId ? `AND ad_group.id = ${adGroupId}` : ""}`);
        const byKey = new Map<string, Row>();
        for (const row of metricRows) {
          byKey.set(`${String(obj(row.adGroup).id ?? "")}~${String(obj(row.adGroupCriterion).criterionId ?? "")}`, obj(row.metrics));
        }
        keywords = keywords.map((kw) => {
          const m = byKey.get(`${kw.ad_group_id}~${kw.criterion_id}`) ?? {};
          const spend = microsToMoney(m.costMicros);
          const conversions = num(m.conversions);
          return {
            ...kw,
            impressions: num(m.impressions),
            clicks: num(m.clicks),
            spend: round2(spend),
            conversions: round2(conversions),
            cpa: conversions ? round2(spend / conversions) : null,
            conversions_value: round2(num(m.conversionsValue)),
          };
        });
      }

      const byStatus: Record<string, number> = {};
      const byFix: Record<string, number> = {};
      for (const kw of keywords) {
        const key = String(kw.primary_status ?? "DESCONHECIDO");
        byStatus[key] = (byStatus[key] ?? 0) + 1;
        for (const code of kw.fix as string[]) byFix[code] = (byFix[code] ?? 0) + 1;
      }
      const summary = { total: keywords.length, by_primary_status: byStatus, by_fix: byFix, ...(scan ? { scan } : {}) };
      let head: string;
      if (!scan) {
        const truncated = rows.length >= max ? ` (limite de ${max} atingido — filtre por campanha/grupo ou aumente limit)` : "";
        head = `${keywords.length} palavra(s)-chave${truncated}.`;
      } else {
        const cap = ISSUE_SCAN_CAP.toLocaleString("pt-BR");
        const shown = matched > max ? ` (mostrando ${max} — limite atingido; aumente limit ou filtre por campanha/grupo)` : "";
        if (!scan.complete) {
          head =
            `ATENÇÃO — busca INCOMPLETA: ${matched} palavra(s)-chave com problema encontrada(s)${shown}, mas pode haver mais. ` +
            `A conta passa de ${cap} palavras-chave no filtro e as consultas dirigidas de ${scan.truncated_checks.join("; ")} ` +
            `também pararam no teto de ${cap} linhas. Filtre por campaignId/adGroupId (ou percorra campanha a campanha) para ver tudo.`;
        } else if (scan.mode === "targeted") {
          head =
            `${matched} palavra(s)-chave com problema${shown}. A conta passa de ${cap} palavras-chave no filtro: ` +
            `a busca foi dirigida por problema (${ISSUE_CANDIDATE_QUERIES.length} consultas, todas completas).`;
        } else {
          head = `${matched} palavra(s)-chave com problema${shown} (varredura completa de ${scan.checked_rows} palavra(s)-chave).`;
        }
      }
      if (format === "table" || format === "csv") {
        return { content: [text(`${head}\nResumo: ${formatJson(summary)}\n\n${renderRows(keywords, format)}`)] };
      }
      return { content: [text(`${head}\n\n${formatJson({ summary, keywords })}`)] };
    }
  );

  // ── add_keywords ────────────────────────────────────────────────────

  mcp.registerTool(
    "add_keywords",
    {
      description: [
        "Adiciona várias palavras-chave a um grupo de anúncios numa chamada.",
        "WRITE OPERATION — partialFailure: as válidas entram e cada recusada volta com o motivo.",
        "",
        `Valida antes da API: texto até ${KEYWORD_MAX_CHARS} caracteres e ${KEYWORD_MAX_WORDS} palavras, sem colchetes/aspas`,
        "(a correspondência vai em matchType), sem +modificador; lance inteiro positivo em micros; URL http(s).",
        "Pula as que já existem no grupo (mesmo texto e correspondência, inclusive pausadas — nunca reativa)",
        `e as repetidas no pedido. Até ${MAX_KEYWORDS_PER_CALL} por chamada. Grupos SEARCH_DYNAMIC_ADS não aceitam palavra-chave.`,
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios."),
        keywords: flexArray(
          z.object({
            text: z.string().describe("Texto da palavra-chave, sem colchetes/aspas."),
            matchType: z.enum(KEYWORD_MATCH_TYPES).describe("EXACT, PHRASE ou BROAD."),
            cpcBidMicros: z.number().optional().describe("Lance em micros (sobrepõe o do grupo). 2500000 = R$2,50."),
            finalUrl: z.string().optional().describe("URL final própria (http/https)."),
          })
        ).describe("Lista de palavras-chave: [{text, matchType, cpcBidMicros?, finalUrl?}]."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Status das novas. Default: ENABLED."),
      },
    },
    async ({ customerId, adGroupId, keywords, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return addKeywordsToAdGroup(getClient(), customerId, adGroupId, ensureArray<unknown>(keywords), { status });
    }
  );

  // ── bulk_update_keyword_status ──────────────────────────────────────

  mcp.registerTool(
    "bulk_update_keyword_status",
    {
      description: [
        "Pausa ou ativa várias palavras-chave de uma vez (sem apagar histórico).",
        "WRITE OPERATION — confere cada uma na conta antes, pula as que já estão no status pedido,",
        "as removidas e as negativas, e grava com partialFailure (relatório por item).",
        "",
        "Informe as palavras-chave como \"adGroupId~criterionId\" (IDs de list_keywords).",
        `Mais de ${BULK_STATUS_CONFIRM_THRESHOLD} mudanças exigem confirm: true.`,
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(z.string()).describe("Lista de \"adGroupId~criterionId\" (ou o resource name customers/{cid}/adGroupCriteria/{adGroupId}~{criterionId})."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("Novo status."),
        confirm: z.boolean().optional().describe(`Obrigatório (true) quando mais de ${BULK_STATUS_CONFIRM_THRESHOLD} palavras-chave mudam.`),
      },
    },
    async ({ customerId, keywords, status, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (status !== "ENABLED" && status !== "PAUSED") return fail(`status inválido "${String(status)}": use ENABLED ou PAUSED.`);
      const cid = customerId.replace(/-/g, "");
      const refs = ensureArray<unknown>(keywords).map((value) => String(value).trim());
      if (refs.length === 0) return fail("Informe ao menos uma palavra-chave (\"adGroupId~criterionId\"). Nada foi alterado.");
      if (refs.length > MAX_KEYWORDS_PER_CALL) return fail(`Máximo de ${MAX_KEYWORDS_PER_CALL} por chamada (recebidas ${refs.length}). Nada foi alterado.`);
      const invalid: string[] = [];
      const wanted = new Map<string, { adGroupId: string; criterionId: string }>();
      for (const ref of refs) {
        const match = /^(?:customers\/([\d-]+)\/adGroupCriteria\/)?(\d+)~(\d+)$/.exec(ref);
        if (!match) {
          invalid.push(`"${ref}" (esperado adGroupId~criterionId)`);
          continue;
        }
        if (match[1] && match[1].replace(/-/g, "") !== cid) {
          invalid.push(`"${ref}" pertence a outra conta`);
          continue;
        }
        wanted.set(`${match[2]}~${match[3]}`, { adGroupId: match[2], criterionId: match[3] });
      }
      if (invalid.length) return fail(`Referências inválidas — nada foi alterado:\n- ${invalid.join("\n- ")}`);

      const client = getClient();
      const resourceNames = [...wanted.keys()].map((key) => `'customers/${cid}/adGroupCriteria/${key}'`);
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_criterion.resource_name, ad_group_criterion.criterion_id,
                ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.type,
                ad_group.id, ad_group.name, ad_group.status, campaign.name, campaign.status
         FROM ad_group_criterion
         WHERE ad_group_criterion.resource_name IN (${resourceNames.join(", ")})`);
      const found = new Map<string, Row>();
      for (const row of rows) {
        const criterion = obj(row.adGroupCriterion);
        found.set(`${String(obj(row.adGroup).id ?? "")}~${String(criterion.criterionId ?? "")}`, row);
      }

      const notFound: string[] = [];
      const skipped: Row[] = [];
      const toChange: Array<{ key: string; row: Row }> = [];
      for (const key of wanted.keys()) {
        const row = found.get(key);
        if (!row) {
          notFound.push(key);
          continue;
        }
        const criterion = obj(row.adGroupCriterion);
        const keyword = obj(criterion.keyword);
        const describe = { id: key, keyword: keyword.text, match_type: keyword.matchType, status: criterion.status };
        if (criterion.type !== undefined && criterion.type !== "KEYWORD") skipped.push({ ...describe, reason: `não é palavra-chave (${String(criterion.type)})` });
        else if (criterion.status === "REMOVED") skipped.push({ ...describe, reason: "removida" });
        else if (criterion.negative === true) skipped.push({ ...describe, reason: "negativa (não tem pausa; use remove_keyword)" });
        else if (criterion.status === status) skipped.push({ ...describe, reason: `já está ${status}` });
        else toChange.push({ key, row });
      }

      const report = { not_found: notFound, skipped };
      if (toChange.length === 0) {
        return {
          content: [text(`Nada a mudar — nenhuma palavra-chave precisa ir para ${status}. Nenhuma escrita foi enviada.\n\n${formatJson(report)}`)],
          ...(notFound.length ? { isError: true } : {}),
        };
      }
      const preview = toChange.map(({ key, row }) => {
        const keyword = obj(obj(row.adGroupCriterion).keyword);
        return { id: key, keyword: keyword.text, match_type: keyword.matchType, before: obj(row.adGroupCriterion).status, after: status };
      });
      if (toChange.length > BULK_STATUS_CONFIRM_THRESHOLD && confirm !== true) {
        return fail(
          `${toChange.length} palavras-chave mudariam para ${status} — acima de ${BULK_STATUS_CONFIRM_THRESHOLD} é preciso confirm: true. Nada foi alterado.\n\n` +
          formatJson({ would_change: preview, ...report })
        );
      }
      const warnings: string[] = [];
      if (status === "ENABLED") {
        const inactive = toChange.filter(({ row }) => obj(row.adGroup).status !== "ENABLED" || obj(row.campaign).status !== "ENABLED");
        if (inactive.length) warnings.push(`${inactive.length} ficam ativas em grupo/campanha pausado — só veiculam quando o grupo e a campanha estiverem ativos.`);
      }

      const operations = toChange.map(({ key }) => ({
        update: { resourceName: `customers/${cid}/adGroupCriteria/${key}`, status },
        updateMask: "status",
      }));
      const result = await client.mutate(customerId, "adGroupCriteria", operations, { partialFailure: true });
      const dryRun = client.isDryRun;
      const { byIndex, unattributed } = partialFailureByOperation(result.partialFailureError, operations.length);
      const results = (result.results as Row[] | undefined) ?? [];
      const changed: Row[] = [];
      const errors: Row[] = [];
      preview.forEach((item, index) => {
        const itemErrors = byIndex.get(index);
        if (itemErrors) errors.push({ ...item, error: itemErrors.join("; ") });
        else if (dryRun || results[index]?.resourceName) changed.push(item);
        else errors.push({ ...item, error: "a API não confirmou a alteração" });
      });
      const head = dryRun
        ? `${DRY_RUN_NOTE} ${changed.length} de ${operations.length} passariam para ${status}.`
        : `${changed.length} de ${operations.length} palavra(s)-chave → ${status}.`;
      return {
        content: [text(`${head}\n\n${formatJson({
          [dryRun ? "validated" : "changed"]: changed,
          errors,
          ...(unattributed.length ? { unattributed_errors: unattributed } : {}),
          ...report,
          warnings,
        })}`)],
        ...(errors.length || unattributed.length || notFound.length ? { isError: true } : {}),
      };
    }
  );

  // ── get_search_term_insights ────────────────────────────────────────

  mcp.registerTool(
    "get_search_term_insights",
    {
      description: [
        "Search term insights: termos de pesquisa agrupados em categorias e subcategorias, com volume",
        "de pesquisa (faixa min–max), impressões, cliques, conversões e valor. Cobre Pesquisa e",
        "Performance Max — mostra o que o PMax e a correspondência ampla estão comprando.",
        "Dados a partir de março de 2023.",
        "",
        "level account (default): customer_search_term_insight — o recomendado pelo Google para começar",
        "(com campaignId, filtra a campanha pelo segmento campaign).",
        "level campaign: campaign_search_term_insight (exige campaignId) — mais pesado; a API pode",
        "responder RESOURCE_EXHAUSTED, e então a tool volta para o nível de conta da mesma campanha.",
        "",
        "Para abrir uma categoria: categoryId (o category_id de uma linha) + includeSubcategories e/ou",
        "includeTerms. Com includeTerms a API não devolve volume de pesquisa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["account", "campaign"]).optional().describe("account (default) ou campaign."),
        campaignId: z.string().optional().describe("Campanha (obrigatória em level campaign)."),
        categoryId: z.string().optional().describe("category_id de uma categoria, para abrir subcategorias/termos."),
        includeSubcategories: z.boolean().optional().describe("Com categoryId: quebra por subcategoria."),
        includeTerms: z.boolean().optional().describe("Com categoryId: lista os termos da categoria (sem volume)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máximo de linhas. Default: 50 (teto 1000)."),
        format: formatSchema,
      },
    },
    async ({ customerId, level, campaignId, categoryId, includeSubcategories, includeTerms, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const scope = level ?? "account";
      if (scope !== "account" && scope !== "campaign") return fail(`level inválido "${String(level)}": use account ou campaign.`);
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (categoryId !== undefined && !NUMERIC_ID.test(categoryId)) return fail(`categoryId deve ser numérico (o category_id de uma linha), recebido "${categoryId}".`);
      if (scope === "campaign" && !campaignId) return fail("level campaign exige campaignId (campaign_search_term_insight é consultado por campanha).");
      const drill = Boolean(includeSubcategories || includeTerms);
      if (drill && !categoryId) {
        return fail("includeSubcategories/includeTerms abrem UMA categoria: informe categoryId (o category_id de uma linha da consulta sem esses parâmetros).");
      }
      if (drill && scope === "account" && campaignId) {
        return fail("No nível de conta a API não combina o segmento de campanha com subcategorias/termos. Use level: \"campaign\" com o categoryId daquela campanha.");
      }
      const max = parseLimit(limit, 50, 1000);
      if (typeof max === "string") return fail(max);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const notes: string[] = [];
      if (dateRange?.since && dateRange.since < "2023-03-01") notes.push("A API só tem search term insights a partir de março de 2023.");
      if (includeTerms) notes.push("Com termos a API não devolve search_volume (métrica incompatível com o segmento search_term).");

      const cid = customerId.replace(/-/g, "");
      const buildQuery = (target: "account" | "campaign"): string => {
        const resource = target === "account" ? "customer_search_term_insight" : "campaign_search_term_insight";
        const select = [`${resource}.id`, `${resource}.category_label`];
        const where = [dateClause];
        if (target === "campaign") {
          select.push("campaign_search_term_insight.campaign_id");
          where.push(`campaign_search_term_insight.campaign_id = ${campaignId}`);
        } else if (campaignId) {
          select.push("segments.campaign");
          where.push(`segments.campaign = 'customers/${cid}/campaigns/${campaignId}'`);
        }
        if (categoryId) where.push(`${resource}.id = ${categoryId}`);
        if (drill) select.push("segments.search_subcategory");
        if (includeTerms) select.push("segments.search_term");
        select.push("metrics.impressions", "metrics.clicks", "metrics.ctr", "metrics.conversions", "metrics.conversions_value");
        if (!includeTerms) select.push("metrics.search_volume");
        return `SELECT ${select.join(", ")}
         FROM ${resource}
         WHERE ${where.join("\n           AND ")}
         ORDER BY metrics.conversions DESC, metrics.clicks DESC
         LIMIT ${max}`;
      };

      const client = getClient();
      let used: "account" | "campaign" = scope;
      let rows: Row[];
      try {
        rows = await client.searchStream(customerId, buildQuery(scope));
      } catch (err) {
        const message = (err as Error).message;
        if (!RESOURCE_EXHAUSTED.test(message)) throw err;
        if (scope === "campaign" && !drill) {
          // O Google recomenda o nível de conta primeiro: o de campanha pesa mais e esgota a cota antes.
          used = "account";
          notes.push("campaign_search_term_insight respondeu RESOURCE_EXHAUSTED; os dados vieram do nível de conta, filtrados pela campanha.");
          rows = await client.searchStream(customerId, buildQuery("account"));
        } else {
          return fail(
            `A API recusou por cota (RESOURCE_EXHAUSTED) mesmo após novas tentativas: ${message}\n` +
            "Search term insights por campanha pesam mais — tente de novo mais tarde, reduza o período ou comece pelo nível de conta (level: \"account\")."
          );
        }
      }

      const insights = rows.map((row) => {
        const insight = obj(used === "account" ? row.customerSearchTermInsight : row.campaignSearchTermInsight);
        const segments = obj(row.segments);
        const m = obj(row.metrics);
        const clicks = num(m.clicks);
        const conversions = num(m.conversions);
        return {
          category_id: String(insight.id ?? ""),
          category: insight.categoryLabel ? String(insight.categoryLabel) : "(outras — sem categoria)",
          ...(drill ? { subcategory: segments.searchSubcategory ? String(segments.searchSubcategory) : "(outras)" } : {}),
          ...(includeTerms ? { search_term: segments.searchTerm ?? null } : {}),
          ...(campaignId ? { campaign_id: campaignId } : {}),
          impressions: num(m.impressions),
          clicks,
          ctr_pct: round2(num(m.ctr) * 100),
          conversions: round2(conversions),
          conversion_rate_pct: clicks ? round2((conversions / clicks) * 100) : null,
          conversions_value: round2(num(m.conversionsValue)),
          ...(includeTerms ? {} : volumeRange(m)),
        };
      });
      insights.sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks);
      const source = used === "account" ? "customer_search_term_insight" : "campaign_search_term_insight";
      const head = `${insights.length} linha(s) de search term insights (${source}${campaignId ? `, campanha ${campaignId}` : ""}${categoryId ? `, categoria ${categoryId}` : ""}).`;
      return {
        content: [text(`${head}${notes.length ? `\nNotas: ${notes.join(" ")}` : ""}\n\n${renderRows(insights, format)}`)],
      };
    }
  );

  // ── audit_dsa_and_legacy ────────────────────────────────────────────

  mcp.registerTool(
    "audit_dsa_and_legacy",
    {
      description: [
        "Auditoria (só leitura) de Anúncios Dinâmicos de Pesquisa (DSA) e das estruturas legadas que o",
        "Google está migrando para AI Max. Não altera nada.",
        "",
        "Traz: campanhas com DSA (domínio, idioma, só URLs fornecidas, AI Max ligado?), page feeds",
        "vinculados (asset sets PAGE_FEED via campaign_asset_set), grupos SEARCH_DYNAMIC_ADS, alvos de",
        "página (webpage) com cobertura e exemplos de URL, critérios de página na campanha (exclusões",
        "WEBPAGE e listas WEBPAGE_LIST), principais termos (os 1.000 de maior custo) e páginas de destino",
        "do DSA no período (soma de todas as linhas até 50.000; data_notes avisa quando algo foi limitado),",
        "correspondência ampla no nível da campanha e as datas em que o Google migrou ACA / ampla para",
        "AI Max (aca_migration_date_time, broad_match_migration_date_time), com recomendações.",
        "",
        "Cronograma (blog Google Ads API, jun/ago 2026): criação de DSA termina em janeiro de 2027;",
        "automigração dos DSA restantes para AI Max em fevereiro de 2027.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        termsLimit: z.number().optional().describe("Quantos termos e páginas de DSA mostrar. Default: 25 (teto 200)."),
      },
    },
    async ({ customerId, dateRange, days, termsLimit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const top = parseLimit(termsLimit, 25, 200, "termsLimit");
      if (typeof top === "string") return fail(top);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const client = getClient();

      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.bidding_strategy_type,
                campaign.dynamic_search_ads_setting.domain_name,
                campaign.dynamic_search_ads_setting.language_code,
                campaign.dynamic_search_ads_setting.use_supplied_urls_only,
                campaign.keyword_match_type, campaign.ai_max_setting.enable_ai_max,
                campaign.aca_migration_date_time, campaign.broad_match_migration_date_time
         FROM campaign
         WHERE campaign.advertising_channel_type = 'SEARCH'
           AND campaign.status != 'REMOVED'`);
      const adGroupRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.name
         FROM ad_group
         WHERE ad_group.type = 'SEARCH_DYNAMIC_ADS'
           AND ad_group.status != 'REMOVED'
           AND campaign.status != 'REMOVED'`);
      const targetRows = await client.searchStream(customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative,
                ad_group_criterion.webpage.criterion_name, ad_group_criterion.webpage.conditions,
                ad_group_criterion.webpage.coverage_percentage, ad_group_criterion.webpage.sample.sample_urls,
                ad_group.id, ad_group.name, campaign.id
         FROM ad_group_criterion
         WHERE ad_group_criterion.type = 'WEBPAGE'
           AND ad_group_criterion.status != 'REMOVED'
           AND ad_group.status != 'REMOVED'`);
      const campaignCriterionRows = await client.searchStream(customerId,
        `SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative,
                campaign_criterion.status, campaign_criterion.webpage.criterion_name,
                campaign_criterion.webpage.conditions, campaign_criterion.webpage_list.shared_set,
                campaign.id, campaign.name
         FROM campaign_criterion
         WHERE campaign_criterion.type IN ('WEBPAGE', 'WEBPAGE_LIST')
           AND campaign_criterion.status != 'REMOVED'`);

      const adGroupsByCampaign = new Map<string, Row[]>();
      for (const row of adGroupRows) {
        const adGroup = obj(row.adGroup);
        const campaignKey = String(obj(row.campaign).id ?? "");
        adGroupsByCampaign.set(campaignKey, [
          ...(adGroupsByCampaign.get(campaignKey) ?? []),
          { id: String(adGroup.id ?? ""), name: adGroup.name, status: adGroup.status },
        ]);
      }
      const targetsByCampaign = new Map<string, Row[]>();
      for (const row of targetRows) {
        const criterion = obj(row.adGroupCriterion);
        const webpage = obj(criterion.webpage);
        const campaignKey = String(obj(row.campaign).id ?? "");
        const coverage = webpage.coveragePercentage === undefined ? null : num(webpage.coveragePercentage);
        targetsByCampaign.set(campaignKey, [
          ...(targetsByCampaign.get(campaignKey) ?? []),
          {
            ad_group_id: String(obj(row.adGroup).id ?? ""),
            ad_group: obj(row.adGroup).name,
            criterion_id: String(criterion.criterionId ?? ""),
            name: webpage.criterionName ?? null,
            negative: criterion.negative === true,
            status: criterion.status,
            conditions: ((webpage.conditions as Row[] | undefined) ?? []).map((c) => `${String(c.operand ?? "")} ${String(c.operator ?? "")} ${String(c.argument ?? "")}`.trim()),
            // coverage_percentage: 1 = 100% (proto WebpageInfo)
            coverage_pct: coverage === null ? null : round2(coverage * 100),
            sample_urls: ((obj(webpage.sample).sampleUrls as string[] | undefined) ?? []).slice(0, 3),
          },
        ]);
      }
      const exclusionsByCampaign = new Map<string, Row[]>();
      for (const row of campaignCriterionRows) {
        const criterion = obj(row.campaignCriterion);
        const campaignKey = String(obj(row.campaign).id ?? "");
        exclusionsByCampaign.set(campaignKey, [
          ...(exclusionsByCampaign.get(campaignKey) ?? []),
          {
            criterion_id: String(criterion.criterionId ?? ""),
            type: criterion.type,
            negative: criterion.negative === true,
            name: obj(criterion.webpage).criterionName ?? null,
            conditions: ((obj(criterion.webpage).conditions as Row[] | undefined) ?? []).map((c) => `${String(c.operand ?? "")} ${String(c.operator ?? "")} ${String(c.argument ?? "")}`.trim()),
            // WEBPAGE_LIST é uma lista de páginas em shared set ("not publicly available" no proto
            // v25) — não é o page feed do DSA, que é um asset set PAGE_FEED (page_feeds, abaixo).
            webpage_list_shared_set: obj(criterion.webpageList).sharedSet ?? null,
          },
        ]);
      }

      // Page feeds do DSA são assets PAGE_FEED agrupados num AssetSet e vinculados à campanha por
      // CampaignAssetSet (guia "Dynamic Search Ads Page Feeds"). Só consulta se houver DSA.
      const isDsaCampaign = (row: Row): boolean => {
        const campaign = obj(row.campaign);
        return Boolean(obj(campaign.dynamicSearchAdsSetting).domainName) || adGroupsByCampaign.has(String(campaign.id ?? ""));
      };
      const pageFeedRows = campaignRows.some(isDsaCampaign)
        ? await client.searchStream(customerId,
            `SELECT campaign.id, campaign_asset_set.asset_set, campaign_asset_set.status,
                    asset_set.id, asset_set.name, asset_set.type, asset_set.status
             FROM campaign_asset_set
             WHERE asset_set.type = 'PAGE_FEED'
               AND campaign_asset_set.status != 'REMOVED'`)
        : [];
      const pageFeedsByCampaign = new Map<string, Row[]>();
      for (const row of pageFeedRows) {
        const link = obj(row.campaignAssetSet);
        const assetSet = obj(row.assetSet);
        const campaignKey = String(obj(row.campaign).id ?? "");
        pageFeedsByCampaign.set(campaignKey, [
          ...(pageFeedsByCampaign.get(campaignKey) ?? []),
          {
            asset_set_id: String(assetSet.id ?? ""),
            name: assetSet.name ?? null,
            asset_set_status: assetSet.status ?? null,
            link_status: link.status ?? null,
            asset_set: link.assetSet ?? null,
          },
        ]);
      }

      const dsaCampaigns: Row[] = [];
      const legacyBroad: Row[] = [];
      const migrated: Row[] = [];
      const recommendations: string[] = [];
      for (const row of campaignRows) {
        const campaign = obj(row.campaign);
        const id = String(campaign.id ?? "");
        const dsa = obj(campaign.dynamicSearchAdsSetting);
        const aiMax = obj(campaign.aiMaxSetting).enableAiMax === true;
        const dsaGroups = adGroupsByCampaign.get(id) ?? [];
        const domain = dsa.domainName ? String(dsa.domainName) : "";
        if (isDsaCampaign(row)) {
          const targets = targetsByCampaign.get(id) ?? [];
          const pageFeeds = pageFeedsByCampaign.get(id) ?? [];
          dsaCampaigns.push({
            campaign_id: id,
            campaign: campaign.name,
            status: campaign.status,
            domain: domain || null,
            language: dsa.languageCode ?? null,
            use_supplied_urls_only: dsa.useSuppliedUrlsOnly === true,
            ai_max_enabled: aiMax,
            bidding_strategy: campaign.biddingStrategyType ?? null,
            dsa_ad_groups: dsaGroups,
            page_feeds: pageFeeds,
            webpage_targets: targets,
            campaign_webpage_criteria: exclusionsByCampaign.get(id) ?? [],
          });
          if (dsa.useSuppliedUrlsOnly === true && !pageFeeds.some((feed) => feed.asset_set_status !== "REMOVED")) {
            recommendations.push(`Campanha ${id} (${String(campaign.name ?? "")}) usa só URLs fornecidas (use_supplied_urls_only) e não tem page feed (asset set PAGE_FEED) ativo vinculado: confira de onde vêm as URLs antes da migração.`);
          }
          if (!aiMax && campaign.status === "ENABLED") {
            recommendations.push(`Campanha ${id} (${String(campaign.name ?? "")}) usa DSA sem AI Max: planeje a migração antes de fev/2027 — teste AI Max (set_ai_max_settings) em experimento e leve os termos que convertem para palavras-chave (add_keywords).`);
          }
          const lowCoverage = targets.filter((t) => !t.negative && t.coverage_pct !== null && Number(t.coverage_pct) < 10);
          if (lowCoverage.length) {
            recommendations.push(`Campanha ${id}: ${lowCoverage.length} alvo(s) de página com cobertura abaixo de 10% — revise as condições.`);
          }
        }
        if (campaign.keywordMatchType === "BROAD") {
          legacyBroad.push({ campaign_id: id, campaign: campaign.name, status: campaign.status, migrated_at: campaign.broadMatchMigrationDateTime ?? null });
        }
        if (campaign.acaMigrationDateTime || campaign.broadMatchMigrationDateTime) {
          migrated.push({
            campaign_id: id,
            campaign: campaign.name,
            aca_migrated_at: campaign.acaMigrationDateTime ?? null,
            broad_match_migrated_at: campaign.broadMatchMigrationDateTime ?? null,
            ai_max_enabled: aiMax,
          });
        }
      }
      if (legacyBroad.some((c) => !c.migrated_at)) {
        recommendations.push("Há campanhas com correspondência ampla no nível da campanha ainda não migradas: a criação dessa configuração foi bloqueada em 03/08/2026 e a migração automática para AI Max ocorre em setembro de 2026.");
      }
      if (migrated.length) {
        recommendations.push(`${migrated.length} campanha(s) já migradas pelo Google para AI Max (ACA ou ampla): confira as configurações de AI Max (get_ai_max_report) — o padrão da migração liga Search Term Matching.`);
      }

      let dsaTerms: Row[] = [];
      let dsaLandingPages: Row[] = [];
      const dataNotes: string[] = [];
      let dataIncomplete = false;
      if (dsaCampaigns.length) {
        // Termos: os de maior custo, para listar e para achar os que convertem sem palavra-chave.
        const termRows = await client.searchStream(customerId,
          `SELECT dynamic_search_ads_search_term_view.search_term,
                  dynamic_search_ads_search_term_view.landing_page,
                  dynamic_search_ads_search_term_view.headline,
                  dynamic_search_ads_search_term_view.has_matching_keyword,
                  dynamic_search_ads_search_term_view.has_negative_keyword,
                  campaign.id, campaign.name, ad_group.id,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM dynamic_search_ads_search_term_view
           WHERE ${dateClause}
             AND metrics.impressions > 0
           ORDER BY metrics.cost_micros DESC
           LIMIT ${DSA_TOP_TERMS_SCAN}`);
        // Páginas: consulta própria, só com a página e as métricas, para somar TODAS as linhas
        // termo × página do período — os termos baratos da cauda longa também convertem.
        const pageRows = await client.searchStream(customerId,
          `SELECT dynamic_search_ads_search_term_view.landing_page,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM dynamic_search_ads_search_term_view
           WHERE ${dateClause}
             AND metrics.impressions > 0
           ORDER BY metrics.cost_micros DESC
           LIMIT ${DSA_PAGE_SCAN_CAP}`);
        const termsTruncated = termRows.length >= DSA_TOP_TERMS_SCAN;
        const pagesComplete = pageRows.length < DSA_PAGE_SCAN_CAP;

        dsaTerms = termRows.map((row) => {
          const view = obj(row.dynamicSearchAdsSearchTermView);
          const m = obj(row.metrics);
          return {
            search_term: view.searchTerm,
            landing_page: view.landingPage ?? null,
            headline: view.headline ?? null,
            has_matching_keyword: view.hasMatchingKeyword === true,
            campaign_id: String(obj(row.campaign).id ?? ""),
            ad_group_id: String(obj(row.adGroup).id ?? ""),
            impressions: num(m.impressions),
            clicks: num(m.clicks),
            spend: round2(microsToMoney(m.costMicros)),
            conversions: round2(num(m.conversions)),
            conversions_value: round2(num(m.conversionsValue)),
          };
        });
        const pages = new Map<string, { impressions: number; clicks: number; costMicros: number; conversions: number; value: number; rows: number }>();
        for (const row of pageRows) {
          const page = String(obj(row.dynamicSearchAdsSearchTermView).landingPage ?? "");
          const m = obj(row.metrics);
          const agg = pages.get(page) ?? { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, value: 0, rows: 0 };
          agg.impressions += num(m.impressions);
          agg.clicks += num(m.clicks);
          agg.costMicros += num(m.costMicros);
          agg.conversions += num(m.conversions);
          agg.value += num(m.conversionsValue);
          agg.rows += 1;
          pages.set(page, agg);
        }
        dsaLandingPages = [...pages.entries()]
          .map(([page, agg]) => ({
            landing_page: page || null,
            term_rows: agg.rows,
            impressions: agg.impressions,
            clicks: agg.clicks,
            spend: round2(agg.costMicros / 1_000_000),
            conversions: round2(agg.conversions),
            conversions_value: round2(agg.value),
          }))
          .sort((a, b) => b.spend - a.spend)
          .slice(0, top);

        const topTerms = DSA_TOP_TERMS_SCAN.toLocaleString("pt-BR");
        const pageCap = DSA_PAGE_SCAN_CAP.toLocaleString("pt-BR");
        if (termsTruncated) {
          dataIncomplete = true;
          dataNotes.push(
            `dsa_top_search_terms e a contagem de termos que convertem sem palavra-chave vêm só dos ${topTerms} termos de maior custo do período (limite da consulta): termos mais baratos ficaram de fora.`
          );
        }
        if (pagesComplete) {
          dataNotes.push(`dsa_top_landing_pages soma todas as ${pageRows.length} linha(s) termo × página do período.`);
        } else {
          dataIncomplete = true;
          dataNotes.push(
            `dsa_top_landing_pages soma só as ${pageCap} linhas termo × página de maior custo (limite da consulta): totais por página subestimados, ` +
            "e a recomendação de exclusão de URL não foi emitida porque a amostra pode esconder conversões da cauda longa. Reduza o período para ter totais completos."
          );
        }

        const winners = dsaTerms.filter((t) => Number(t.conversions) > 0 && !t.has_matching_keyword);
        if (winners.length) {
          recommendations.push(
            `${winners.length} termo(s) de DSA com conversão ainda sem palavra-chave${termsTruncated ? ` (entre os ${topTerms} de maior custo)` : ""}: candidatos a add_keywords antes da migração.`
          );
        }
        if (pagesComplete) {
          const wastedPages = dsaLandingPages.filter((p) => Number(p.spend) > 0 && Number(p.conversions) === 0);
          if (wastedPages.length) {
            recommendations.push(`${wastedPages.length} página(s) de destino do DSA com gasto e sem conversão no período (totais completos): avalie exclusão de URL.`);
          }
        }
        dsaTerms = dsaTerms.slice(0, top);
      }

      const payload = {
        summary: {
          search_campaigns: campaignRows.length,
          dsa_campaigns: dsaCampaigns.length,
          dsa_ad_groups: adGroupRows.length,
          webpage_targets: targetRows.length,
          dsa_page_feeds: dsaCampaigns.reduce((total, c) => total + (c.page_feeds as Row[]).length, 0),
          campaign_level_broad_match: legacyBroad.length,
          migrated_to_ai_max: migrated.length,
        },
        timeline: [
          "Criação de DSA restaurada em 15/06/2026 e encerrada em janeiro de 2027.",
          "Fevereiro de 2027: automigração dos DSA restantes para AI Max.",
          "Setembro de 2026: migração automática de ampla no nível da campanha e ACA para AI Max.",
        ],
        dsa_campaigns: dsaCampaigns,
        dsa_top_search_terms: dsaTerms,
        dsa_top_landing_pages: dsaLandingPages,
        ...(dataNotes.length ? { data_notes: dataNotes } : {}),
        campaign_level_broad_match: legacyBroad,
        migrated_campaigns: migrated,
        recommendations,
      };
      const head = dsaCampaigns.length
        ? `${dsaCampaigns.length} campanha(s) com DSA, ${adGroupRows.length} grupo(s) DSA, ${targetRows.length} alvo(s) de página, ${payload.summary.dsa_page_feeds} page feed(s).` +
          (dataIncomplete ? " Atenção: termos/páginas do DSA limitados pelo teto das consultas — veja data_notes." : "")
        : "Nenhuma campanha com DSA encontrada.";
      return { content: [text(`${head}\n\n${formatJson(payload)}`)] };
    }
  );
}
