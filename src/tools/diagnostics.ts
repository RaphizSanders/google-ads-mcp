/**
 * Lote diagnostics: diagnóstico de veiculação, parcela de impressões e reprovações.
 *
 * - diagnose_campaigns: status primário (primary_status + motivos), serving_status e status do
 *   sistema de lances de cada campanha não removida — inclusive as que pararam de veicular e por
 *   isso somem dos relatórios de performance —, com explicação em PT-BR e a tool que resolve.
 * - get_account_health: status da conta, índice de otimização, auto-tagging, rastreamento de
 *   conversões, cliques inválidos e campanhas por status primário.
 * - get_impression_share: parcela de impressões (Pesquisa ou Display) com perdas por orçamento e
 *   por ranking, topo e topo absoluto, por conta/campanha/grupo/palavra-chave/produto.
 * - list_policy_issues: anúncios, assets e palavras-chave reprovados ou limitados, com tópicos,
 *   evidências (ex.: destino fora do ar com código HTTP) e restrições por país.
 * - request_keyword_policy_exemption / request_ad_policy_exemption: pedido de exceção de política
 *   (exempt_policy_violation_keys / ignorable_policy_topics), só depois de o usuário confirmar
 *   cada política que a própria API apontou numa validação prévia (validate_only).
 *
 * Tudo conferido na v25: campos em tests/fixtures/google-ads-v25-fields.json, compatibilidade
 * métrica × segmento na field reference (metrics), enums e mensagens de erro nos protos oficiais.
 */
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  LOW_BID_MICROS,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  isPositiveMicros,
  microsToMoney,
  num,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const NUMERIC_ID = /^\d+$/;
const fail = (message: string) => ({ content: [text(message)], isError: true });

/**
 * CSV sem nada a avisar sai puro. Aviso (ex.: limite de linhas atingido) entra antes, em linhas
 * "# ...", para o corte não passar calado; resultado vazio vira "# <cabeçalho>", nunca string vazia.
 */
function csvWithNotes(rows: Row[], header: string, notes: string[]): string {
  const csv = formatAsCsv(rows);
  return [...(csv ? notes : [header, ...notes]).map((note) => `# ${note}`), csv].filter(Boolean).join("\n");
}

/** json e table levam o cabeçalho e os avisos (uma linha cada) antes do corpo. */
function render(rows: Row[], format: string | undefined, header: string, json: unknown, notes: string[] = []): string {
  const top = [header, ...notes].join("\n");
  if (format === "table") return `${top}\n\n${formatAsTable(rows)}`;
  if (format === "csv") return csvWithNotes(rows, header, notes);
  return `${top}\n\n${formatJson(json)}`;
}

function parseLimit(limit: number | undefined, fallback: number, max: number): number | string {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) return `limit inválido: ${limit}. Use um inteiro entre 1 e ${max}.`;
  return value;
}

// ── Severidade e explicações dos status primários ───────────────────

type Severity = "ok" | "info" | "atencao" | "problema";
const SEVERITY_RANK: Record<Severity, number> = { ok: 0, info: 1, atencao: 2, problema: 3 };
const worst = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);

/** [gravidade, explicação, ação sugerida] */
type ReasonInfo = [Severity, string, string?];

const INHERITED: Record<string, ReasonInfo> = {
  CAMPAIGN_REMOVED: ["info", "A campanha foi removida."],
  CAMPAIGN_PAUSED: ["info", "A campanha está pausada."],
  CAMPAIGN_PENDING: ["info", "A campanha ainda não começou (data de início no futuro)."],
  CAMPAIGN_ENDED: ["info", "A campanha já terminou (data de término passou)."],
  CAMPAIGN_DRAFT: ["info", "Pertence a uma campanha rascunho (draft)."],
  AD_GROUP_PAUSED: ["info", "O grupo de anúncios está pausado."],
  AD_GROUP_REMOVED: ["info", "O grupo de anúncios foi removido."],
};

/** CampaignPrimaryStatusReason (v25). */
export const CAMPAIGN_REASONS: Record<string, ReasonInfo> = {
  CAMPAIGN_REMOVED: ["info", "Campanha removida."],
  CAMPAIGN_PAUSED: ["info", "Pausada pelo usuário.", "update_campaign (status ENABLED) — só se a pausa não foi intencional."],
  CAMPAIGN_PENDING: ["atencao", "A data de início ainda não chegou (campaign.start_date_time no futuro); começa sozinha nessa data."],
  CAMPAIGN_ENDED: ["info", "A data de término já passou (campaign.end_date_time).", "Estenda a data de término se a campanha deveria continuar."],
  CAMPAIGN_DRAFT: ["info", "É um rascunho (draft) — não veicula por si."],
  BIDDING_STRATEGY_MISCONFIGURED: ["problema", "Estratégia de lances mal configurada — o detalhe está em bidding_strategy_system_status.", "Veja o status da estratégia abaixo; em geral list_conversion_actions ou update_campaign."],
  BIDDING_STRATEGY_LIMITED: ["atencao", "Estratégia de lances limitada (dados, teto/piso de CPC, qualidade ou inventário).", "Veja bidding_strategy_system_status; update_campaign para teto de CPC ou metas."],
  BIDDING_STRATEGY_LEARNING: ["atencao", "Lances automáticos em aprendizado após mudança recente.", "Evite novas mudanças de lance, orçamento e conversões até o aprendizado terminar."],
  BIDDING_STRATEGY_CONSTRAINED: ["atencao", "A meta de CPA/ROAS está restringindo — uma meta mais folgada traria mais valor de conversão.", "update_campaign (targetCpaMicros / targetRoas)."],
  BUDGET_CONSTRAINED: ["atencao", "O orçamento está limitando a entrega.", "get_impression_share (confira a perda por orçamento) e update_budget."],
  BUDGET_MISCONFIGURED: ["problema", "Orçamento com configuração incorreta.", "update_budget."],
  SEARCH_VOLUME_LIMITED: ["atencao", "A campanha não alcança todas as pesquisas relevantes (pouco volume nas palavras-chave/segmentação atuais).", "generate_keyword_ideas + create_keyword; revise tipos de correspondência e segmentação."],
  AD_GROUPS_PAUSED: ["problema", "Todos os grupos de anúncios estão pausados.", "update_ad_group (status ENABLED) no grupo que deve veicular."],
  NO_AD_GROUPS: ["problema", "Não há grupo de anúncios elegível.", "create_ad_group."],
  KEYWORDS_PAUSED: ["problema", "Todas as palavras-chave estão pausadas.", "update_keyword (status) — drillDown keywords mostra quais."],
  NO_KEYWORDS: ["problema", "Não há palavra-chave elegível.", "create_keyword."],
  AD_GROUP_ADS_PAUSED: ["problema", "Todos os anúncios estão pausados.", "update_ad_status (ENABLED) — drillDown ads mostra quais."],
  NO_AD_GROUP_ADS: ["problema", "Não há anúncio elegível.", "create_ad."],
  HAS_ADS_LIMITED_BY_POLICY: ["atencao", "Há anúncios limitados por política.", "list_policy_issues (scope ads)."],
  HAS_ADS_DISAPPROVED: ["problema", "Há anúncios reprovados.", "list_policy_issues (scope ads); request_ad_policy_exemption quando a política admitir exceção."],
  MOST_ADS_UNDER_REVIEW: ["atencao", "A maioria dos anúncios está em revisão.", "Aguarde a revisão; acompanhe com list_policy_issues."],
  MISSING_LEAD_FORM_EXTENSION: ["problema", "A meta é formulário de lead, mas falta o recurso (asset) de formulário.", "Adicione um asset de formulário de lead à campanha."],
  MISSING_CALL_EXTENSION: ["problema", "A meta é ligação, mas falta o recurso (asset) de ligação.", "create_call_extension."],
  LEAD_FORM_EXTENSION_UNDER_REVIEW: ["atencao", "O formulário de lead está em revisão."],
  LEAD_FORM_EXTENSION_DISAPPROVED: ["problema", "O formulário de lead foi reprovado.", "list_policy_issues (scope assets)."],
  CALL_EXTENSION_UNDER_REVIEW: ["atencao", "O recurso de ligação está em revisão."],
  CALL_EXTENSION_DISAPPROVED: ["problema", "O recurso de ligação foi reprovado.", "list_policy_issues (scope assets)."],
  NO_MOBILE_APPLICATION_AD_GROUP_CRITERIA: ["problema", "Campanha de app sem critério de aplicativo móvel elegível."],
  CAMPAIGN_GROUP_PAUSED: ["info", "O grupo de campanhas está pausado."],
  CAMPAIGN_GROUP_ALL_GROUP_BUDGETS_ENDED: ["problema", "Todos os orçamentos do grupo de campanhas já terminaram."],
  APP_NOT_RELEASED: ["problema", "O app não está publicado nos países segmentados."],
  APP_PARTIALLY_RELEASED: ["atencao", "O app está publicado só em parte dos países segmentados."],
  HAS_ASSET_GROUPS_DISAPPROVED: ["problema", "Há grupos de recursos (PMax) reprovados.", "diagnose_campaigns com drillDown asset_groups; list_policy_issues (scope assets)."],
  HAS_ASSET_GROUPS_LIMITED_BY_POLICY: ["atencao", "Há grupos de recursos (PMax) limitados por política.", "list_policy_issues (scope assets)."],
  MOST_ASSET_GROUPS_UNDER_REVIEW: ["atencao", "A maioria dos grupos de recursos está em revisão."],
  NO_ASSET_GROUPS: ["problema", "Não há grupo de recursos elegível.", "create_asset_group."],
  ASSET_GROUPS_PAUSED: ["problema", "Todos os grupos de recursos estão pausados.", "update_asset_group (status)."],
  MISSING_LOCATION_TARGETING: ["problema", "A campanha tem restrição de local, mas nenhuma segmentação geográfica.", "set_campaign_locations."],
  CAMPAIGN_NOT_BOOKED: ["problema", "Campanha de CPM fixo (reserva) ainda não reservada."],
  BOOKING_HOLD_EXPIRING: ["atencao", "A reserva de inventário (CPM fixo) está expirando."],
  BOOKING_HOLD_EXPIRED: ["problema", "A reserva de inventário (CPM fixo) expirou."],
  BOOKING_CANCELLED: ["problema", "A reserva (CPM fixo) foi cancelada automaticamente."],
};

/** BiddingStrategySystemStatus (v25). */
export const BIDDING_STATUS: Record<string, ReasonInfo> = {
  ENABLED: ["ok", "Estratégia ativa, sem problema identificado."],
  LEARNING_NEW: ["atencao", "Aprendizado: estratégia criada ou reativada há pouco."],
  LEARNING_SETTING_CHANGE: ["atencao", "Aprendizado: mudança recente de configuração."],
  LEARNING_BUDGET_CHANGE: ["atencao", "Aprendizado: mudança recente de orçamento."],
  LEARNING_COMPOSITION_CHANGE: ["atencao", "Aprendizado: mudou o número de campanhas, grupos ou palavras-chave da estratégia."],
  LEARNING_CONVERSION_TYPE_CHANGE: ["atencao", "Aprendizado: mudaram os tipos de conversão usados pela estratégia."],
  LEARNING_CONVERSION_SETTING_CHANGE: ["atencao", "Aprendizado: mudaram as configurações de conversão."],
  LIMITED_BY_CPC_BID_CEILING: ["atencao", "Limitada pelo teto de CPC.", "update_campaign (cpcBidCeilingMicros)."],
  LIMITED_BY_CPC_BID_FLOOR: ["atencao", "Limitada pelo piso de CPC."],
  LIMITED_BY_DATA: ["atencao", "Limitada por poucas conversões nas últimas semanas."],
  LIMITED_BY_BUDGET: ["atencao", "Boa parte das palavras-chave está limitada por orçamento.", "get_impression_share e update_budget."],
  LIMITED_BY_LOW_PRIORITY_SPEND: ["atencao", "Não atinge o gasto alvo porque o gasto foi despriorizado."],
  LIMITED_BY_LOW_QUALITY: ["atencao", "Boa parte das palavras-chave tem Índice de Qualidade baixo.", "get_keyword_performance (quality_score) e revisão de anúncios/páginas."],
  LIMITED_BY_INVENTORY: ["atencao", "Não gasta o orçamento todo por segmentação estreita."],
  MISCONFIGURED_ZERO_ELIGIBILITY: ["problema", "Sem rastreamento de conversão ativo (nenhum ping) e/ou sem listas de remarketing.", "list_conversion_actions / create_conversion_action."],
  MISCONFIGURED_CONVERSION_TYPES: ["problema", "Faltam tipos de conversão que a estratégia possa otimizar.", "create_conversion_action / set_campaign_conversion_goals."],
  MISCONFIGURED_CONVERSION_SETTINGS: ["problema", "Configurações de conversão incorretas para esta estratégia.", "list_conversion_actions / update_conversion_action."],
  MISCONFIGURED_SHARED_BUDGET: ["problema", "Há campanhas fora da estratégia compartilhando o orçamento com campanhas dela."],
  MISCONFIGURED_STRATEGY_TYPE: ["problema", "Tipo de estratégia inválido para a campanha — ela não veicula.", "update_campaign (estratégia de lances)."],
  PAUSED: ["info", "Estratégia inativa: nenhuma campanha, grupo, palavra-chave ou orçamento ativo ligado a ela."],
  UNAVAILABLE: ["info", "Esta estratégia não informa status."],
  MULTIPLE_LEARNING: ["atencao", "Vários status de aprendizado no período."],
  MULTIPLE_LIMITED: ["atencao", "Vários status de limitação no período."],
  MULTIPLE_MISCONFIGURED: ["problema", "Vários status de configuração incorreta no período."],
  MULTIPLE: ["atencao", "Vários status diferentes no período."],
};

const PRIMARY_STATUS_SEVERITY: Record<string, Severity> = {
  ELIGIBLE: "ok",
  PAUSED: "info",
  REMOVED: "info",
  ENDED: "info",
  PENDING: "atencao",
  LEARNING: "atencao",
  LIMITED: "atencao",
  MISCONFIGURED: "problema",
  NOT_ELIGIBLE: "problema",
};

/**
 * Cada enum de motivo (v25) tem só parte dos herdados: CAMPAIGN_DRAFT só existe no de grupo;
 * AD_GROUP_PAUSED/REMOVED não existem no de grupo de recursos. As tabelas precisam bater com o
 * enum porque os códigos vão para o GAQL (CONTAINS ANY / CONTAINS NONE) no drill-down.
 */
const inherited = (...codes: string[]): Record<string, ReasonInfo> =>
  Object.fromEntries(codes.map((code) => [code, INHERITED[code]]));

/** AdGroupPrimaryStatusReason (v25) — todos os valores. */
export const AD_GROUP_REASONS: Record<string, ReasonInfo> = {
  ...inherited("CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "CAMPAIGN_DRAFT", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED"),
  AD_GROUP_INCOMPLETE: ["problema", "A configuração do grupo não está completa."],
  KEYWORDS_PAUSED: ["problema", "Todas as palavras-chave do grupo estão pausadas.", "update_keyword (status)."],
  NO_KEYWORDS: ["problema", "O grupo não tem palavra-chave elegível.", "create_keyword."],
  AD_GROUP_ADS_PAUSED: ["problema", "Todos os anúncios do grupo estão pausados.", "update_ad_status (ENABLED)."],
  NO_AD_GROUP_ADS: ["problema", "O grupo não tem anúncio elegível.", "create_ad."],
  HAS_ADS_DISAPPROVED: ["problema", "Há anúncios reprovados no grupo.", "list_policy_issues (scope ads)."],
  HAS_ADS_LIMITED_BY_POLICY: ["atencao", "Há anúncios limitados por política no grupo.", "list_policy_issues (scope ads)."],
  MOST_ADS_UNDER_REVIEW: ["atencao", "A maioria dos anúncios do grupo está em revisão."],
  AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY: ["atencao", "Pausado automaticamente pelo Google por baixa atividade prolongada.", "update_ad_group (status ENABLED) se o grupo ainda for útil."],
};

/** AdGroupAdPrimaryStatusReason (v25) — todos os valores. */
export const AD_REASONS: Record<string, ReasonInfo> = {
  ...inherited("CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED"),
  AD_GROUP_AD_PAUSED: ["info", "Anúncio pausado pelo usuário."],
  AD_GROUP_AD_REMOVED: ["info", "Anúncio removido."],
  AD_GROUP_AD_DISAPPROVED: ["problema", "Anúncio reprovado.", "list_policy_issues (scope ads) mostra tópico e evidência."],
  AD_GROUP_AD_UNDER_REVIEW: ["atencao", "Anúncio em revisão."],
  AD_GROUP_AD_POOR_QUALITY: ["atencao", "Anúncio de qualidade baixa (avaliação da própria veiculação).", "Reescreva títulos/descrições (update_ad)."],
  AD_GROUP_AD_NO_ADS: ["atencao", "Nenhuma variação do anúncio pôde ser gerada."],
  AD_GROUP_AD_APPROVED_LABELED: ["atencao", "Aprovado com limitação de política.", "list_policy_issues (scope ads)."],
  AD_GROUP_AD_AREA_OF_INTEREST_ONLY: ["atencao", "Só veicula para quem pesquisa sobre a área segmentada (não nos países segmentados)."],
  AD_GROUP_AD_UNDER_APPEAL: ["info", "Em recurso (appeal) — não muda o status."],
};

/** AdGroupCriterionPrimaryStatusReason (v25) — todos os valores. */
export const KEYWORD_REASONS: Record<string, ReasonInfo> = {
  ...inherited("CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED"),
  CAMPAIGN_CRITERION_NEGATIVE: ["problema", "Bloqueada por uma palavra-chave negativa da campanha.", "list_negative_keywords / remove_negative_keyword."],
  AD_GROUP_CRITERION_DISAPPROVED: ["problema", "Palavra-chave reprovada por política.", "list_policy_issues (scope keywords)."],
  AD_GROUP_CRITERION_RARELY_SERVED: ["atencao", "Raramente veiculada (pouco volume de pesquisa)."],
  AD_GROUP_CRITERION_LOW_QUALITY: ["atencao", "Índice de Qualidade baixo.", "Revise relevância do anúncio e da página de destino."],
  AD_GROUP_CRITERION_UNDER_REVIEW: ["atencao", "Em revisão."],
  AD_GROUP_CRITERION_PENDING_REVIEW: ["atencao", "Aguardando revisão."],
  AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID: ["atencao", "Lance abaixo do necessário para a primeira página.", "update_keyword (cpcBidMicros) — só com estratégia manual."],
  AD_GROUP_CRITERION_NEGATIVE: ["info", "É uma palavra-chave negativa."],
  AD_GROUP_CRITERION_RESTRICTED: ["problema", "Palavra-chave restrita."],
  AD_GROUP_CRITERION_PAUSED: ["info", "Pausada pelo usuário."],
  AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY: ["atencao", "Pausada automaticamente por baixa atividade prolongada."],
  AD_GROUP_CRITERION_REMOVED: ["info", "Removida."],
};

/** AssetGroupPrimaryStatusReason (v25) — todos os valores. */
export const ASSET_GROUP_REASONS: Record<string, ReasonInfo> = {
  ...inherited("CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED"),
  ASSET_GROUP_PAUSED: ["info", "Grupo de recursos pausado pelo usuário."],
  ASSET_GROUP_REMOVED: ["info", "Grupo de recursos removido."],
  ASSET_GROUP_LIMITED: ["atencao", "Aprovado, mas veiculando de forma limitada por política.", "list_policy_issues (scope assets)."],
  ASSET_GROUP_DISAPPROVED: ["problema", "Grupo de recursos reprovado.", "list_policy_issues (scope assets)."],
  ASSET_GROUP_UNDER_REVIEW: ["atencao", "Grupo de recursos em revisão."],
};

function explainReasons(codes: unknown, table: Record<string, ReasonInfo>) {
  return arr(codes).map((code) => {
    const info = table[String(code)];
    return {
      codigo: String(code),
      gravidade: info?.[0] ?? "atencao",
      explicacao: info?.[1] ?? "Motivo sem explicação cadastrada nesta versão.",
      ...(info?.[2] ? { acao: info[2] } : {}),
    };
  });
}

/**
 * Gravidade de uma entidade. Os motivos explicam o status, então mandam quando existem: um grupo
 * NOT_ELIGIBLE só porque a campanha está pausada (CAMPAIGN_PAUSED, herdado) é "info", não problema;
 * um grupo PAUSED por AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY (pausa automática do Google) é "atencao".
 * Sem motivos, vale o status primário.
 */
function entitySeverity(primaryStatus: unknown, reasons: Array<{ gravidade: Severity | string }>): Severity {
  if (reasons.length === 0) return PRIMARY_STATUS_SEVERITY[String(primaryStatus ?? "")] ?? "atencao";
  return reasons.reduce<Severity>((acc, reason) => worst(acc, reason.gravidade as Severity), "ok");
}

// ── Drill-down do diagnose_campaigns ────────────────────────────────

type DrillLevel = "ad_groups" | "ads" | "keywords" | "asset_groups";

interface DrillSpec {
  /** Recurso do FROM e prefixo dos campos de status da entidade. */
  entity: string;
  select: string;
  /** Sempre: nada removido. */
  base: string;
  /** Com onlyProblems, além da campanha ativa: anúncio/palavra-chave de grupo pausado não é urgente. */
  activeParents: string;
  /** Tabela de motivos = enum completo da entidade na v25. */
  table: Record<string, ReasonInfo>;
  /** Status primários do enum da entidade que valem atenção/problema mesmo sem motivo. */
  statuses: string[];
  /** Identidade da linha, para juntar as consultas sem repetir. */
  key: (row: Row) => string;
  map: (row: Row) => Row;
}

const DRILL: Record<DrillLevel, DrillSpec> = {
  ad_groups: {
    entity: "ad_group",
    select: `ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status,
             ad_group.primary_status_reasons, campaign.id, campaign.name`,
    base: "ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    // O grupo pausado pelo Google por baixa atividade fica com status PAUSED: não dá para exigir ENABLED aqui.
    activeParents: "",
    table: AD_GROUP_REASONS,
    statuses: ["NOT_ELIGIBLE", "LIMITED", "PENDING"],
    key: (row) => String(obj(row.adGroup).id),
    map: (row) => {
      const g = obj(row.adGroup);
      return { nivel: "grupo", id: g.id, nome: g.name, status: g.status, primary_status: g.primaryStatus, reasons: g.primaryStatusReasons };
    },
  },
  ads: {
    entity: "ad_group_ad",
    select: `ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.primary_status,
             ad_group_ad.primary_status_reasons, ad_group_ad.policy_summary.approval_status,
             ad_group_ad.policy_summary.review_status, ad_group.id, ad_group.name,
             campaign.id, campaign.name`,
    base: "ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    activeParents: " AND ad_group.status = 'ENABLED'",
    table: AD_REASONS,
    statuses: ["NOT_ELIGIBLE", "LIMITED", "PENDING"],
    key: (row) => `${String(obj(row.adGroup).id)}~${String(obj(obj(row.adGroupAd).ad).id)}`,
    map: (row) => {
      const a = obj(row.adGroupAd);
      const ad = obj(a.ad);
      const policy = obj(a.policySummary);
      return {
        nivel: "anuncio", id: ad.id, nome: ad.type, status: a.status, primary_status: a.primaryStatus,
        reasons: a.primaryStatusReasons, aprovacao: policy.approvalStatus ?? null, revisao: policy.reviewStatus ?? null,
        grupo: obj(row.adGroup).name,
      };
    },
  },
  keywords: {
    entity: "ad_group_criterion",
    select: `ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
             ad_group_criterion.keyword.match_type, ad_group_criterion.status,
             ad_group_criterion.primary_status, ad_group_criterion.primary_status_reasons,
             ad_group_criterion.system_serving_status, ad_group_criterion.approval_status,
             ad_group_criterion.quality_info.quality_score, ad_group.id, ad_group.name,
             campaign.id, campaign.name`,
    base: `ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
           AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'
           AND campaign.status != 'REMOVED'`,
    activeParents: " AND ad_group.status = 'ENABLED'",
    table: KEYWORD_REASONS,
    // AdGroupCriterionPrimaryStatus não tem LIMITED (enum v25).
    statuses: ["NOT_ELIGIBLE", "PENDING"],
    key: (row) => `${String(obj(row.adGroup).id)}~${String(obj(row.adGroupCriterion).criterionId)}`,
    map: (row) => {
      const k = obj(row.adGroupCriterion);
      const kw = obj(k.keyword);
      return {
        nivel: "palavra-chave", id: k.criterionId, nome: `[${String(kw.matchType ?? "")}] ${String(kw.text ?? "")}`,
        status: k.status, primary_status: k.primaryStatus, reasons: k.primaryStatusReasons,
        veiculacao: k.systemServingStatus ?? null, aprovacao: k.approvalStatus ?? null,
        quality_score: obj(k.qualityInfo).qualityScore ?? null, grupo: obj(row.adGroup).name,
      };
    },
  },
  asset_groups: {
    entity: "asset_group",
    select: `asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status,
             asset_group.primary_status_reasons, asset_group.ad_strength, campaign.id, campaign.name`,
    base: "asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    activeParents: "",
    table: ASSET_GROUP_REASONS,
    statuses: ["NOT_ELIGIBLE", "LIMITED", "PENDING"],
    key: (row) => String(obj(row.assetGroup).id),
    map: (row) => {
      const g = obj(row.assetGroup);
      return {
        nivel: "grupo de recursos", id: g.id, nome: g.name, status: g.status, primary_status: g.primaryStatus,
        reasons: g.primaryStatusReasons, ad_strength: g.adStrength ?? null,
      };
    },
  },
};

const gaqlList = (values: string[]) => `(${values.map((value) => `'${value}'`).join(", ")})`;
const codesWith = (table: Record<string, ReasonInfo>, severity: Severity) =>
  Object.keys(table).filter((code) => table[code][0] === severity);

/**
 * Queries do drill-down. Sem onlyProblems: uma, sem filtro de status. Com onlyProblems, o filtro
 * vai no GAQL (senão o LIMIT corta antes e linhas saudáveis ou herdadas tomam as vagas) e segue
 * a mesma regra da gravidade — os motivos mandam, e o status primário sozinho não basta:
 * - grupo pausado pelo Google por baixa atividade tem status PAUSED (AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY
 *   "contributes to PAUSED") e grupo ELIGIBLE pode ter HAS_ADS_DISAPPROVED ("contributes to multiple");
 * - todo grupo de campanha encerrada mas ainda ENABLED fica NOT_ELIGIBLE por CAMPAIGN_ENDED (herdado).
 * GAQL não tem OR, então são três consultas, cada uma com o próprio LIMIT, juntas sem repetir:
 * 1. algum motivo "problema" do próprio nível; 2. algum motivo "atencao" (em consulta separada para
 * os de atenção — ex.: milhares de palavras-chave com QS baixo — não tirarem a vaga dos reprovados);
 * 3. status NOT_ELIGIBLE/LIMITED/PENDING sem nenhum motivo conhecido.
 * Escopo: campanha ENABLED e não encerrada (campaign.primary_status != ENDED) e, para anúncio e
 * palavra-chave, grupo ENABLED — pendência embaixo de algo pausado/encerrado não é urgente.
 */
function drillQueries(spec: DrillSpec, campaignFilter: string, maxRows: number, problemsOnly: boolean): string[] {
  const query = (where: string) =>
    `SELECT ${spec.select}
     FROM ${spec.entity}
     WHERE ${spec.base}${campaignFilter}${where}
     LIMIT ${maxRows}`;
  if (!problemsOnly) return [query("")];
  const scope = ` AND campaign.status = 'ENABLED' AND campaign.primary_status != 'ENDED'${spec.activeParents}`;
  const reasons = `${spec.entity}.primary_status_reasons`;
  return [
    ...(["problema", "atencao"] as const)
      .map((severity) => codesWith(spec.table, severity))
      .filter((codes) => codes.length > 0)
      .map((codes) => query(`${scope} AND ${reasons} CONTAINS ANY ${gaqlList(codes)}`)),
    query(`${scope} AND ${spec.entity}.primary_status IN ${gaqlList(spec.statuses)} AND ${reasons} CONTAINS NONE ${gaqlList(Object.keys(spec.table))}`),
  ];
}

function drillFilterText(level: DrillLevel): string {
  return `só campanhas ativas e não encerradas${DRILL[level].activeParents ? " e grupos ativos" : ""}; entidades com ` +
    `motivo de atenção/problema no próprio nível ou status ${DRILL[level].statuses.join("/")} sem motivo ` +
    "(onlyProblems=false mostra tudo)";
}

// ── Parcela de impressões ────────────────────────────────────────────

/**
 * Parcela de impressões em texto. A API trunca: parcela abaixo de 10% vem como 0.0999 e perda
 * acima de 90% vem como 0.9001 (field reference, metrics.search_*_impression_share).
 */
export function formatShare(value: unknown, kind: "share" | "lost"): string | null {
  if (value === undefined || value === null || value === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (kind === "share" && Math.abs(v - 0.0999) < 1e-9) return "<10%";
  if (kind === "lost" && Math.abs(v - 0.9001) < 1e-9) return ">90%";
  return `${round2(v * 100)}%`;
}

const numOrNull = (value: unknown): number | null =>
  value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/** Rótulo do gargalo: limiares de 10 p.p. são heurística da agência, não regra do Google. */
export function impressionShareDiagnosis(share: unknown, lostBudget: unknown, lostRank: unknown): string {
  const is = numOrNull(share);
  const budget = numOrNull(lostBudget) ?? 0;
  const rank = numOrNull(lostRank) ?? 0;
  if (is === null) return "sem dados de parcela";
  if (budget >= 0.1 && budget >= rank) return "limitada por orçamento";
  if (rank >= 0.1) return "limitada por ranking (lance/qualidade)";
  if (is >= 0.9) return "parcela alta (≥ 90%)";
  return "sem gargalo dominante";
}

/** Campos de parcela que get_campaign_performance / get_ad_group_performance acrescentam. */
export const PERFORMANCE_IS_FIELDS = [
  "metrics.search_impression_share",
  "metrics.search_budget_lost_impression_share",
  "metrics.search_rank_lost_impression_share",
  "metrics.search_top_impression_share",
  "metrics.search_absolute_top_impression_share",
].join(", ");

export function performanceImpressionShare(metrics: Row | undefined) {
  const m = metrics ?? {};
  return {
    search_impression_share: formatShare(m.searchImpressionShare, "share"),
    lost_is_budget: formatShare(m.searchBudgetLostImpressionShare, "lost"),
    lost_is_rank: formatShare(m.searchRankLostImpressionShare, "lost"),
    top_impression_share: formatShare(m.searchTopImpressionShare, "share"),
    absolute_top_impression_share: formatShare(m.searchAbsoluteTopImpressionShare, "share"),
    is_diagnosis: impressionShareDiagnosis(m.searchImpressionShare, m.searchBudgetLostImpressionShare, m.searchRankLostImpressionShare),
  };
}

interface ShareMetric {
  field: string;
  json: string;
  label: string;
  kind: "share" | "lost" | "pct";
  /** Níveis e segmentos em que a field reference NÃO lista a métrica como selecionável. */
  notLevels?: string[];
  notSegments?: string[];
}

const toJsonKey = (field: string) => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const share = (field: string, label: string, kind: ShareMetric["kind"], notLevels?: string[], notSegments?: string[]): ShareMetric =>
  ({ field, json: toJsonKey(field), label, kind, notLevels, notSegments });

/** Compatibilidade conferida em developers.google.com/google-ads/api/fields/v25/metrics (Selectable with). */
const SEARCH_SHARE_METRICS: ShareMetric[] = [
  share("search_impression_share", "parcela_impressoes", "share"),
  share("search_budget_lost_impression_share", "perdida_orcamento", "lost"),
  share("search_rank_lost_impression_share", "perdida_ranking", "lost"),
  share("search_top_impression_share", "parcela_topo", "share", ["product"]),
  share("search_absolute_top_impression_share", "parcela_topo_absoluto", "share"),
  share("search_budget_lost_top_impression_share", "topo_perdida_orcamento", "lost", ["product"]),
  share("search_rank_lost_top_impression_share", "topo_perdida_ranking", "lost", ["product"]),
  share("search_budget_lost_absolute_top_impression_share", "topo_abs_perdida_orcamento", "lost"),
  share("search_rank_lost_absolute_top_impression_share", "topo_abs_perdida_ranking", "lost"),
  share("search_exact_match_impression_share", "parcela_correspondencia_exata", "share", ["product"], ["hour"]),
  share("top_impression_percentage", "pct_impressoes_topo", "pct", ["product"]),
  share("absolute_top_impression_percentage", "pct_impressoes_topo_absoluto", "pct", ["product"]),
];

const DISPLAY_SHARE_METRICS: ShareMetric[] = [
  share("content_impression_share", "parcela_impressoes", "share"),
  share("content_budget_lost_impression_share", "perdida_orcamento", "lost", [], ["hour"]),
  share("content_rank_lost_impression_share", "perdida_ranking", "lost", [], ["hour"]),
];

const IS_LEVELS = {
  account: { from: "customer", entity: ["customer.id", "customer.descriptive_name"], notRemoved: "" },
  campaign: {
    from: "campaign",
    entity: [
      "campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type",
      "campaign.bidding_strategy_type", "campaign.bidding_strategy",
      "campaign.target_impression_share.location", "campaign.target_impression_share.location_fraction_micros",
    ],
    notRemoved: "campaign.status != 'REMOVED'",
  },
  ad_group: {
    from: "ad_group",
    entity: ["ad_group.id", "ad_group.name", "ad_group.status", "campaign.id", "campaign.name"],
    notRemoved: "ad_group.status != 'REMOVED'",
  },
  keyword: {
    from: "keyword_view",
    entity: [
      "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type",
      "ad_group_criterion.status", "ad_group.id", "ad_group.name", "campaign.id", "campaign.name",
    ],
    notRemoved: "ad_group_criterion.status != 'REMOVED'",
  },
  product: {
    from: "shopping_performance_view",
    entity: ["segments.product_item_id", "campaign.id", "campaign.name"],
    notRemoved: "",
  },
} as const;

type IsLevel = keyof typeof IS_LEVELS;

const SEGMENT_FIELDS: Record<string, string> = {
  date: "segments.date",
  week: "segments.week",
  month: "segments.month",
  device: "segments.device",
  day_of_week: "segments.day_of_week",
  hour: "segments.hour",
};

/** keyword_view e shopping_performance_view não aceitam segments.hour (fixture v25). */
const LEVELS_WITHOUT_HOUR = new Set<string>(["keyword", "product"]);

/** AdvertisingChannelType (v25) que não veiculam na rede de Pesquisa — nunca têm search_*_impression_share. */
const NO_SEARCH_SHARE_CHANNELS = ["DISPLAY", "VIDEO", "DEMAND_GEN"];
/** Níveis em que campaign.advertising_channel_type é filtrável (campaign é o FROM ou atribuído). */
const CHANNEL_FILTER_LEVELS = new Set<string>(["campaign", "ad_group", "keyword"]);

const DAYS_OF_WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const compareText = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
/** Comparadores dos segmentos de tempo (date/week/month são ISO: ordem de texto). */
const TIME_SEGMENT_ORDER: Record<string, ((a: unknown, b: unknown) => number) | undefined> = {
  date: compareText,
  week: compareText,
  month: compareText,
  hour: (a, b) => Number(a) - Number(b),
  day_of_week: (a, b) => DAYS_OF_WEEK.indexOf(String(a)) - DAYS_OF_WEEK.indexOf(String(b)),
};

const TARGET_LOCATION_METRIC: Record<string, string> = {
  ANYWHERE_ON_PAGE: "searchImpressionShare",
  TOP_OF_PAGE: "searchTopImpressionShare",
  ABSOLUTE_TOP_OF_PAGE: "searchAbsoluteTopImpressionShare",
};

// ── Políticas: tópicos, evidências e erros estruturados ─────────────

const TOPIC_TYPE_TEXT: Record<string, string> = {
  PROHIBITED: "não veicula",
  LIMITED: "veicula com restrição",
  FULLY_LIMITED: "não veicula com a segmentação atual",
  DESCRIPTIVE: "informativo (não limita)",
  BROADENING: "pode ampliar a cobertura",
  AREA_OF_INTEREST_ONLY: "não veicula nos países segmentados, só para quem pesquisa sobre eles",
};

function describeEvidence(evidence: Row): string {
  const e = obj(evidence);
  if (e.textList) return `texto: ${arr(obj(e.textList).texts).map((t) => `"${String(t)}"`).join(", ")}`;
  if (e.websiteList) return `sites: ${arr(obj(e.websiteList).websites).join(", ")}`;
  if (e.languageCode) return `idioma detectado: ${String(e.languageCode)}`;
  if (e.destinationTextList) {
    return `texto na página de destino: ${arr(obj(e.destinationTextList).destinationTexts).map((t) => `"${String(t)}"`).join(", ")}`;
  }
  if (e.destinationMismatch) return `URLs que não batem entre si: ${arr(obj(e.destinationMismatch).urlTypes).join(", ")}`;
  if (e.destinationNotWorking) {
    const d = obj(e.destinationNotWorking);
    const reason = d.httpErrorCode !== undefined ? `HTTP ${String(d.httpErrorCode)}` : d.dnsErrorType ? `DNS ${String(d.dnsErrorType)}` : "falha";
    return `destino fora do ar: ${String(d.expandedUrl ?? "(URL não informada)")} — ${reason}` +
      `${d.device ? ` no ${String(d.device)}` : ""}${d.lastCheckedDateTime ? `, verificado em ${String(d.lastCheckedDateTime)}` : ""}`;
  }
  return formatJson(e);
}

function describeConstraint(constraint: Row): string {
  const c = obj(constraint);
  const countries = (list: unknown) => {
    const l = obj(list);
    const names = arr(l.countries).map((country) => String(obj(country).countryCriterion ?? "?"));
    return `${names.join(", ")}${l.totalTargetedCountries !== undefined ? ` (de ${String(l.totalTargetedCountries)} país(es) segmentado(s))` : ""}`;
  };
  if (c.countryConstraintList) return `não veicula em: ${countries(c.countryConstraintList)}`;
  if (c.resellerConstraint) return "restrição de revenda (site reprovado para fins de revenda)";
  if (c.certificateMissingInCountryList) return `certificado exigido em: ${countries(c.certificateMissingInCountryList)}`;
  if (c.certificateDomainMismatchInCountryList) return `domínio fora do certificado em: ${countries(c.certificateDomainMismatchInCountryList)}`;
  return formatJson(c);
}

/** Sugestão de correção por evidência/tópico — heurística; o tópico é texto livre da API. */
function fixHint(entry: Row): string {
  const topic = String(entry.topic ?? "").toUpperCase();
  const evidences = arr(entry.evidences).map(obj);
  if (evidences.some((e) => e.destinationNotWorking) || /DESTINATION_NOT_WORKING/.test(topic)) {
    return "Corrija a página de destino (a evidência traz o código HTTP/DNS e o dispositivo) e depois edite/reenvie o anúncio para nova revisão.";
  }
  if (evidences.some((e) => e.destinationMismatch) || /DESTINATION_MISMATCH/.test(topic)) {
    return "URL final, de exibição e de rastreamento precisam apontar para o mesmo domínio: alinhe as URLs (update_ad).";
  }
  if (/TRADEMARK/.test(topic)) {
    return "Marca registrada: se o anunciante é revendedor/autorizado, o dono da marca precisa autorizar a conta junto ao Google; ao criar/editar o anúncio dá para pedir exceção (request_ad_policy_exemption).";
  }
  if (/EDITORIAL|CAPITALIZ|PUNCTUATION|SPELLING|GRAMMAR|SYMBOL|REPETITION|GIMMICK|SPACING|STYLE/.test(topic)) {
    return "Problema editorial: normalmente se resolve reescrevendo o texto apontado na evidência (update_ad / create_ad).";
  }
  if (/ALCOHOL|GAMBLING|HEALTH|PHARMA|MEDIC|DRUG|FINANCIAL|CRYPTO|POLITICAL|ADULT|DATING|WEAPON/.test(topic)) {
    return "Categoria restrita: pode exigir certificação do anunciante e só veicula onde a política permite (veja as restrições por país).";
  }
  return "Veja o tópico na Central de políticas do Google Ads. A API não abre recurso (appeal) de reprovação já decidida — só pedido de exceção ao criar/editar.";
}

export function describeTopicEntry(entry: unknown) {
  const e = obj(entry);
  const type = String(e.type ?? "");
  return {
    topico: String(e.topic ?? ""),
    tipo: type,
    efeito: TOPIC_TYPE_TEXT[type] ?? type,
    evidencias: arr(e.evidences).map((ev) => describeEvidence(obj(ev))),
    restricoes: arr(e.constraints).map((c) => describeConstraint(obj(c))),
    sugestao: fixHint(e),
  };
}

export interface AdsErrorInfo {
  message: string;
  codes: string[];
  trigger?: string;
  fieldPath?: string;
  operationIndex?: number;
  violation?: {
    policyName: string;
    violatingText?: string;
    externalPolicyName?: string;
    description?: string;
    isExemptible: boolean;
  };
  findings?: Row[];
}

/**
 * Lê um GoogleAdsFailure (partialFailureError de um :mutate com partialFailure) sem perder o que
 * o client descarta nos erros lançados: errorCode, trigger, location e details
 * (policyViolationDetails / policyFindingDetails — errors.proto v25).
 */
export function parseAdsFailure(failure: unknown): AdsErrorInfo[] {
  const errors: AdsErrorInfo[] = [];
  for (const detail of arr(obj(failure).details)) {
    for (const raw of arr(obj(detail).errors)) {
      const err = obj(raw);
      const codes = Object.entries(obj(err.errorCode)).map(([k, v]) => `${k}.${String(v)}`);
      const trigger = Object.values(obj(err.trigger))[0];
      const path = arr(obj(err.location).fieldPathElements).map(obj);
      const opElement = path.find((el) => el.fieldName === "operations");
      const info: AdsErrorInfo = {
        message: String(err.message ?? "erro sem mensagem"),
        codes,
        ...(trigger !== undefined ? { trigger: String(trigger) } : {}),
        ...(path.length
          ? { fieldPath: path.map((el) => `${String(el.fieldName)}${el.index !== undefined ? `[${String(el.index)}]` : ""}`).join(".") }
          : {}),
        ...(opElement?.index !== undefined ? { operationIndex: Number(opElement.index) } : {}),
      };
      const details = obj(err.details);
      const violation = obj(details.policyViolationDetails);
      if (Object.keys(violation).length) {
        const key = obj(violation.key);
        info.violation = {
          policyName: String(key.policyName ?? ""),
          ...(key.violatingText !== undefined ? { violatingText: String(key.violatingText) } : {}),
          ...(violation.externalPolicyName ? { externalPolicyName: String(violation.externalPolicyName) } : {}),
          ...(violation.externalPolicyDescription ? { description: String(violation.externalPolicyDescription) } : {}),
          isExemptible: violation.isExemptible === true,
        };
      }
      const findings = arr(obj(details.policyFindingDetails).policyTopicEntries).map(obj);
      if (findings.length) info.findings = findings;
      errors.push(info);
    }
  }
  const failureObj = obj(failure);
  if (!errors.length && (failureObj.message || failureObj.code)) {
    errors.push({ message: String(failureObj.message ?? `código ${String(failureObj.code)}`), codes: [] });
  }
  return errors;
}

const errorLine = (e: AdsErrorInfo) =>
  `${e.message}${e.codes.length ? ` [${e.codes.join(", ")}]` : ""}${e.trigger ? ` (gatilho: "${e.trigger}")` : ""}${e.fieldPath ? ` em ${e.fieldPath}` : ""}`;

/** Roda a operação em validate_only com partialFailure e devolve os erros estruturados. */
async function validateWithDetails(
  client: GoogleAdsClient,
  customerId: string,
  resource: string,
  operation: Row
): Promise<{ errors: AdsErrorInfo[] } | { thrown: string }> {
  const validator = client.isDryRun ? client : client.withDryRun();
  try {
    const response = await validator.mutate(customerId, resource, [operation as unknown as MutateOperation], { partialFailure: true });
    return { errors: parseAdsFailure(response.partialFailureError) };
  } catch (err) {
    return { thrown: (err as Error).message };
  }
}

// ── Registro das tools ───────────────────────────────────────────────

export function registerDiagnosticsTools(ctx: ToolContext): void {
  const { allowedCustomerIds, hosted } = ctx;

  // ── diagnose_campaigns ─────────────────────────────────────────────

  ctx.mcp.registerTool(
    "diagnose_campaigns",
    {
      description: [
        "Por que a campanha não está gastando/veiculando? Lista TODAS as campanhas não removidas (inclusive as",
        "que pararam de veicular e somem de get_campaign_performance) com primary_status e os motivos",
        "(primary_status_reasons: BUDGET_CONSTRAINED, BIDDING_STRATEGY_LEARNING/LIMITED/MISCONFIGURED,",
        "HAS_ADS_DISAPPROVED, NO_KEYWORDS, SEARCH_VOLUME_LIMITED, MISSING_LOCATION_TARGETING...), serving_status,",
        "bidding_strategy_system_status, orçamento e entrega recente. Cada motivo vem com explicação em PT-BR",
        "e a tool que resolve.",
        "onlyProblems (padrão true) esconde campanhas elegíveis sem pendência e as pausadas/encerradas.",
        "drillDown abre o nível de baixo: ad_groups, ads, keywords (system_serving_status, aprovação) ou",
        "asset_groups (PMax). Com onlyProblems, o drill-down traz as entidades com motivo de atenção/problema",
        "(inclusive as pausadas pelo Google por baixa atividade) de campanhas ativas e não encerradas.",
        "Em format table o drill-down vem numa segunda tabela; em csv, no mesmo CSV (coluna nivel).",
        "Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        onlyProblems: z.boolean().optional().describe("Default true: só campanhas com atenção/problema."),
        drillDown: z
          .enum(["none", "ad_groups", "ads", "keywords", "asset_groups"])
          .optional()
          .describe("Detalha o nível abaixo da campanha. Default: none."),
        days: z.number().optional().describe("Janela para medir a entrega recente (impressões/custo). Default: 7."),
        limit: z.number().optional().describe("Máximo de linhas no drill-down. Default 200, máximo 1000."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, onlyProblems, drillDown, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const maxRows = parseLimit(limit, 200, 1000);
      if (typeof maxRows === "string") return fail(maxRows);
      const window = days ?? 7;
      let dateClause: string;
      try {
        dateClause = buildDateClause(undefined, window);
      } catch (err) {
        return fail((err as Error).message);
      }
      const problemsOnly = onlyProblems ?? true;
      const level = drillDown ?? "none";
      const client = ctx.getClient();
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";

      const statusRows = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
                campaign.primary_status, campaign.primary_status_reasons,
                campaign.bidding_strategy_type, campaign.bidding_strategy_system_status,
                campaign.advertising_channel_type, campaign.start_date_time, campaign.end_date_time,
                campaign_budget.amount_micros, campaign_budget.explicitly_shared,
                campaign_budget.has_recommended_budget, campaign_budget.recommended_budget_amount_micros
         FROM campaign
         WHERE campaign.status != 'REMOVED'${campaignFilter}
         ORDER BY campaign.name`
      );
      if (campaignId && statusRows.length === 0) {
        return fail(`Campanha ${campaignId} não encontrada (ou removida) na conta ${customerId}.`);
      }

      // Entrega recente em query separada: com métricas no SELECT, campanha sem entrega some.
      const deliveryRows = await client.searchStream(
        customerId,
        `SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
         FROM campaign
         WHERE ${dateClause} AND campaign.status != 'REMOVED'${campaignFilter}`
      );
      const delivery = new Map<string, Row>();
      for (const row of deliveryRows) delivery.set(String(obj(row.campaign).id), obj(row.metrics));

      const campaigns = statusRows.map((row) => {
        const c = obj(row.campaign);
        const budget = obj(row.campaignBudget);
        const m = delivery.get(String(c.id)) ?? {};
        const reasons = explainReasons(c.primaryStatusReasons, CAMPAIGN_REASONS);
        const biddingCode = String(c.biddingStrategySystemStatus ?? "");
        const bidding = BIDDING_STATUS[biddingCode];
        let severity = entitySeverity(c.primaryStatus, reasons);
        if (severity !== "info" && bidding) severity = worst(severity, bidding[0]);
        const impressions = num(m.impressions);
        const notServing = c.status === "ENABLED" && impressions === 0 && severity !== "info";
        if (notServing) severity = worst(severity, "atencao");
        return {
          campaign_id: String(c.id ?? ""),
          name: c.name,
          type: c.advertisingChannelType,
          status: c.status,
          primary_status: c.primaryStatus ?? null,
          serving_status: c.servingStatus ?? null,
          gravidade: severity,
          motivos: reasons,
          estrategia: {
            tipo: c.biddingStrategyType ?? null,
            status_sistema: biddingCode || null,
            ...(bidding ? { explicacao: bidding[1], ...(bidding[2] ? { acao: bidding[2] } : {}) } : {}),
          },
          orcamento_diario: budget.amountMicros !== undefined ? round2(microsToMoney(budget.amountMicros)) : null,
          orcamento_compartilhado: budget.explicitlyShared ?? null,
          ...(budget.hasRecommendedBudget
            ? { orcamento_recomendado: round2(microsToMoney(budget.recommendedBudgetAmountMicros)) }
            : {}),
          inicio: c.startDateTime ?? null,
          fim: c.endDateTime ?? null,
          entrega_recente: {
            dias: window,
            impressoes: impressions,
            cliques: num(m.clicks),
            custo: round2(microsToMoney(m.costMicros)),
            conversoes: round2(num(m.conversions)),
          },
          ...(notServing ? { alerta: `Ativa, mas sem nenhuma impressão nos últimos ${window} dia(s).` } : {}),
        };
      });

      const shown = problemsOnly
        ? campaigns.filter((c) => c.gravidade === "atencao" || c.gravidade === "problema")
        : campaigns;
      const byStatus: Record<string, number> = {};
      for (const c of campaigns) byStatus[String(c.primary_status)] = (byStatus[String(c.primary_status)] ?? 0) + 1;

      // ── drill-down ──
      let detail: Row[] | undefined;
      let detailTruncated = false;
      if (level !== "none") {
        const spec = DRILL[level];
        const results = await Promise.all(
          drillQueries(spec, campaignFilter, maxRows, problemsOnly).map((query) => client.searchStream(customerId, query))
        );
        detailTruncated = results.some((rows) => rows.length >= maxRows);
        const seen = new Set<string>();
        detail = results
          .flat()
          .filter((row) => {
            const key = spec.key(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((row) => {
            const base = spec.map(row);
            const reasons = explainReasons(base.reasons, spec.table);
            delete base.reasons;
            const c = obj(row.campaign);
            return {
              ...base,
              campaign_id: String(c.id ?? ""),
              campanha: c.name,
              gravidade: entitySeverity(base.primary_status, reasons),
              motivos: reasons,
            } as Row;
          })
          /* Com onlyProblems, fica o que tem atenção/problema no próprio nível — mesmo que a
             campanha esteja elegível (ex.: um grupo sem anúncios numa campanha que veicula). */
          .filter((row) => !problemsOnly || row.gravidade === "atencao" || row.gravidade === "problema")
          .sort((a, b) => SEVERITY_RANK[b.gravidade as Severity] - SEVERITY_RANK[a.gravidade as Severity]);
        if (detail.length > maxRows) {
          detail = detail.slice(0, maxRows);
          detailTruncated = true;
        }
      }

      const summary = {
        conta: customerId,
        janela_entrega_dias: window,
        campanhas_analisadas: campaigns.length,
        campanhas_listadas: shown.length,
        ocultas: problemsOnly ? campaigns.length - shown.length : 0,
        por_primary_status: byStatus,
      };
      const header = problemsOnly
        ? `${shown.length} de ${campaigns.length} campanha(s) com atenção/problema (onlyProblems=true; passe false para ver todas).`
        : `${campaigns.length} campanha(s).`;
      const flat = shown.map((c) => ({
        campaign_id: c.campaign_id,
        name: c.name,
        type: c.type,
        status: c.status,
        primary_status: c.primary_status,
        gravidade: c.gravidade,
        motivos: c.motivos.map((r) => r.codigo).join(" | "),
        estrategia: c.estrategia.status_sistema,
        impressoes: c.entrega_recente.impressoes,
        custo: c.entrega_recente.custo,
      }));
      const truncatedNote = `Limite de ${maxRows} linha(s) do drill-down atingido — pode haver mais itens; aumente limit ou filtre por campaignId.`;
      const filterNote = level !== "none" && problemsOnly ? drillFilterText(level as DrillLevel) : undefined;
      const json = { resumo: summary, campanhas: shown, ...(detail ? {
        detalhe: {
          nivel: level,
          linhas: detail.length,
          ...(detailTruncated ? { aviso: truncatedNote } : {}),
          ...(filterNote ? { filtro: filterNote } : {}),
          itens: detail,
        },
      } : {}) };
      const notes = detailTruncated ? [truncatedNote] : [];
      if (!detail) return { content: [text(render(flat, format, header, json, notes))] };

      /* table e csv também levam o drill-down (antes só o JSON levava: a consulta rodava e o
         resultado sumia). table: segunda tabela; csv: um só CSV, campanhas e detalhe com "nivel". */
      const detailFlat = detail.map((item) => {
        const { nivel, campaign_id, campanha, id, nome, status, primary_status, gravidade, motivos, ...extra } = item;
        return {
          nivel, campaign_id, campanha, id, nome, status, primary_status, gravidade,
          motivos: arr(motivos).map((reason) => String(obj(reason).codigo)).join(" | "),
          ...extra,
        };
      });
      if (format === "csv") {
        const campaignRows = flat.map((c) => ({
          nivel: "campanha", campaign_id: c.campaign_id, campanha: c.name, id: c.campaign_id, nome: c.name,
          status: c.status, primary_status: c.primary_status, gravidade: c.gravidade, motivos: c.motivos,
          tipo: c.type, estrategia: c.estrategia, impressoes: c.impressoes, custo: c.custo,
        }));
        return { content: [text(csvWithNotes([...campaignRows, ...detailFlat], header, notes))] };
      }
      if (format === "table") {
        const detailHeader = `Detalhe (${level}): ${detail.length} linha(s)${filterNote ? ` — ${filterNote}` : ""}.`;
        return {
          content: [text(`${render(flat, format, header, json, notes)}\n\n${detailHeader}\n\n${formatAsTable(detailFlat)}`)],
        };
      }
      return { content: [text(render(flat, format, header, json, notes))] };
    }
  );

  // ── get_account_health ─────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_account_health",
    {
      description: [
        "Saúde da conta em uma chamada: status da conta, índice de otimização, auto-tagging, status do",
        "rastreamento de conversões (e quem gerencia), aceite dos termos de dados do cliente, cliques inválidos",
        "no período, campanhas por primary_status (com os motivos mais comuns) e anúncios reprovados em",
        "campanhas ativas. Traz alertas em PT-BR com a tool que resolve. Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(`${DAYS_DESC} (janela dos cliques inválidos)`),
      },
    },
    async ({ customerId, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const client = ctx.getClient();
      const [info] = await client.searchStream(
        customerId,
        `SELECT customer.id, customer.descriptive_name, customer.status, customer.currency_code,
                customer.time_zone, customer.test_account, customer.manager,
                customer.optimization_score, customer.optimization_score_weight,
                customer.auto_tagging_enabled,
                customer.conversion_tracking_setting.conversion_tracking_status,
                customer.conversion_tracking_setting.accepted_customer_data_terms,
                customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
                customer.conversion_tracking_setting.google_ads_conversion_customer
         FROM customer
         LIMIT 1`
      );
      const c = obj(info?.customer);
      if (!info) return fail(`Conta ${customerId} não encontrada ou sem acesso.`);
      const tracking = obj(c.conversionTrackingSetting);
      const account = {
        id: c.id,
        nome: c.descriptiveName,
        status: c.status,
        moeda: c.currencyCode,
        fuso: c.timeZone,
        conta_teste: c.testAccount ?? false,
        gerenciadora: c.manager ?? false,
      };
      const alerts: Array<{ nivel: Severity; texto: string; acao?: string }> = [];
      if (c.status && c.status !== "ENABLED") {
        alerts.push({ nivel: "problema", texto: `Conta com status ${String(c.status)} — não veicula anúncios.`, acao: "Reative/resolva na interface do Google Ads (suspensão só o suporte do Google reverte)." });
      }
      if (c.manager) {
        return {
          content: [text(`Conta ${customerId} é gerenciadora (MCC): métricas, campanhas e índice de otimização existem só nas contas cliente. Rode get_account_health em cada conta (list_accounts).\n\n${formatJson({ conta: account, alertas: alerts })}`)],
        };
      }

      const [metricsRows, campaignRows, disapprovedRows] = await Promise.all([
        client.searchStream(
          customerId,
          `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
                  metrics.invalid_clicks, metrics.invalid_click_rate
           FROM customer
           WHERE ${dateClause}`
        ),
        client.searchStream(
          customerId,
          `SELECT campaign.id, campaign.status, campaign.primary_status, campaign.primary_status_reasons
           FROM campaign
           WHERE campaign.status != 'REMOVED'`
        ),
        client.searchStream(
          customerId,
          `SELECT ad_group_ad.ad.id, campaign.id
           FROM ad_group_ad
           WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
             AND ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`
        ),
      ]);

      const m = obj(metricsRows[0]?.metrics);
      const byStatus: Record<string, number> = {};
      const reasonCount: Record<string, number> = {};
      for (const row of campaignRows) {
        const camp = obj(row.campaign);
        const status = String(camp.primaryStatus ?? "UNKNOWN");
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        if (camp.status !== "ENABLED") continue;
        for (const reason of arr(camp.primaryStatusReasons)) reasonCount[String(reason)] = (reasonCount[String(reason)] ?? 0) + 1;
      }
      const topReasons = Object.entries(reasonCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([code, count]) => ({ codigo: code, campanhas_ativas: count, explicacao: CAMPAIGN_REASONS[code]?.[1] ?? "—", ...(CAMPAIGN_REASONS[code]?.[2] ? { acao: CAMPAIGN_REASONS[code][2] } : {}) }));

      const optimization = numOrNull(c.optimizationScore);
      if (optimization !== null && optimization < 0.7) {
        alerts.push({ nivel: "atencao", texto: `Índice de otimização em ${round2(optimization * 100)}%.`, acao: "list_recommendations — avalie antes de aplicar; o índice mede adesão às recomendações do Google, não resultado." });
      }
      if (c.autoTaggingEnabled === false) {
        alerts.push({ nivel: "problema", texto: "Auto-tagging (GCLID) desligado: o GA4 e a importação de conversões offline perdem a atribuição por clique.", acao: "Ligue a codificação automática nas configurações da conta." });
      }
      const trackingStatus = String(tracking.conversionTrackingStatus ?? "");
      if (trackingStatus === "NOT_CONVERSION_TRACKED") {
        alerts.push({ nivel: "problema", texto: "A conta não rastreia conversões — lances automáticos de conversão e ROAS ficam sem dados.", acao: "create_conversion_action / list_conversion_actions." });
      } else if (trackingStatus === "CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER") {
        alerts.push({ nivel: "info", texto: "As conversões são gerenciadas por outra conta gerenciadora (conversões entre contas).", acao: "Edite as ações de conversão na MCC dona (google_ads_conversion_customer)." });
      }
      if (tracking.acceptedCustomerDataTerms === false) {
        alerts.push({ nivel: "atencao", texto: "Os termos de dados do cliente não foram aceitos — conversões otimizadas (enhanced conversions) ficam indisponíveis.", acao: "Aceite os termos na interface (Metas > Configurações)." });
      }
      const invalidRate = numOrNull(m.invalidClickRate);
      // Limiar de 10% é heurística de agência para investigar, não regra do Google.
      if (invalidRate !== null && invalidRate >= 0.1) {
        alerts.push({ nivel: "atencao", texto: `Taxa de cliques inválidos em ${round2(invalidRate * 100)}% no período.`, acao: "Investigue origem (get_geo_performance, posicionamentos); o Google não cobra cliques inválidos detectados." });
      }
      const problemCampaigns = (byStatus.NOT_ELIGIBLE ?? 0) + (byStatus.MISCONFIGURED ?? 0);
      if (problemCampaigns > 0) {
        alerts.push({ nivel: "problema", texto: `${problemCampaigns} campanha(s) NOT_ELIGIBLE/MISCONFIGURED.`, acao: "diagnose_campaigns." });
      }
      if ((byStatus.LIMITED ?? 0) > 0) {
        alerts.push({ nivel: "atencao", texto: `${byStatus.LIMITED} campanha(s) LIMITED.`, acao: "diagnose_campaigns / get_impression_share." });
      }
      if (disapprovedRows.length > 0) {
        alerts.push({ nivel: "problema", texto: `${disapprovedRows.length} anúncio(s) ativo(s) reprovado(s) em campanha ativa.`, acao: "list_policy_issues (scope ads)." });
      }

      const health = {
        conta: account,
        otimizacao: {
          optimization_score: optimization === null ? null : `${round2(optimization * 100)}%`,
          peso: numOrNull(c.optimizationScoreWeight),
        },
        rastreamento: {
          auto_tagging: c.autoTaggingEnabled ?? null,
          conversion_tracking_status: trackingStatus || null,
          conta_de_conversao: tracking.googleAdsConversionCustomer ?? null,
          aceitou_termos_dados_cliente: tracking.acceptedCustomerDataTerms ?? null,
          enhanced_conversions_leads: tracking.enhancedConversionsForLeadsEnabled ?? null,
        },
        trafego: {
          impressoes: num(m.impressions),
          cliques: num(m.clicks),
          custo: round2(microsToMoney(m.costMicros)),
          conversoes: round2(num(m.conversions)),
          cliques_invalidos: num(m.invalidClicks),
          taxa_cliques_invalidos: invalidRate === null ? null : `${round2(invalidRate * 100)}%`,
        },
        campanhas: {
          nao_removidas: campaignRows.length,
          por_primary_status: byStatus,
          motivos_mais_comuns_em_ativas: topReasons,
        },
        anuncios_reprovados_em_campanhas_ativas: disapprovedRows.length,
        alertas: alerts.sort((a, b) => SEVERITY_RANK[b.nivel] - SEVERITY_RANK[a.nivel]),
      };
      return { content: [text(`${alerts.length} alerta(s) de saúde da conta.\n\n${formatJson(health)}`)] };
    }
  );

  // ── get_impression_share ───────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_impression_share",
    {
      description: [
        "Parcela de impressões (impression share): quanto das impressões possíveis você levou e por que perdeu",
        "o resto — perdida por orçamento (budget) ou por ranking (lance/qualidade) —, mais topo e topo absoluto.",
        "É o diagnóstico 'orçamento ou lance?'. level: account | campaign | ad_group | keyword | product",
        "(Shopping, por item). network: SEARCH (padrão) ou DISPLAY (só account/campaign/ad_group).",
        "segmentBy: none | date | week | month | device | day_of_week | hour (hour não vale para keyword/product).",
        "A API trunca os valores: parcela abaixo de 10% aparece como \"<10%\" e perda acima de 90% como \">90%\".",
        "Em campanhas TARGET_IMPRESSION_SHARE compara com a meta. Cada linha traz um diagnóstico",
        "(limitada por orçamento / por ranking) — limiar de 10 p.p., heurística. Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "account", "ad_group", "keyword", "product"]).optional().describe("Default: campaign."),
        campaignId: z.string().optional().describe("Filtra por campanha (ID numérico)."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (níveis ad_group e keyword)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        segmentBy: z
          .enum(["none", "date", "week", "month", "device", "day_of_week", "hour"])
          .optional()
          .describe("Default: none."),
        network: z.enum(["SEARCH", "DISPLAY"]).optional().describe("Default: SEARCH."),
        limit: z
          .number()
          .optional()
          .describe("Máximo de linhas (as de maior custo). Default 100, máximo 5000. O cabeçalho avisa quando o limite é atingido."),
        format: formatSchema,
      },
    },
    async ({ customerId, level, campaignId, adGroupId, dateRange, days, segmentBy, network, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const lvl: IsLevel = level ?? "campaign";
      const seg = segmentBy ?? "none";
      const net = network ?? "SEARCH";
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (adGroupId !== undefined && !NUMERIC_ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      if (lvl === "account" && (campaignId || adGroupId)) return fail("level account não aceita campaignId/adGroupId — use level campaign ou ad_group.");
      if (adGroupId && !["ad_group", "keyword"].includes(lvl)) return fail("adGroupId só vale para level ad_group ou keyword.");
      if (net === "DISPLAY" && (lvl === "keyword" || lvl === "product")) {
        return fail("Parcela de impressões de Display (content_*) só existe para account, campaign e ad_group.");
      }
      if (seg === "hour" && LEVELS_WITHOUT_HOUR.has(lvl)) return fail(`segmentBy hour não é aceito pela API em level ${lvl}.`);
      const maxRows = parseLimit(limit, 100, 5000);
      if (typeof maxRows === "string") return fail(maxRows);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days, { granular: seg === "date" || seg === "week" || seg === "hour" });
      } catch (err) {
        return fail((err as Error).message);
      }

      const spec = IS_LEVELS[lvl];
      const metrics = (net === "SEARCH" ? SEARCH_SHARE_METRICS : DISPLAY_SHARE_METRICS).filter(
        (metric) => !metric.notLevels?.includes(lvl) && !metric.notSegments?.includes(seg)
      );
      const segmentField = seg === "none" ? undefined : SEGMENT_FIELDS[seg];
      const select = [
        ...spec.entity,
        ...(segmentField ? [segmentField] : []),
        ...metrics.map((metric) => `metrics.${metric.field}`),
        "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value",
      ];
      const where = [
        dateClause,
        ...(spec.notRemoved ? [spec.notRemoved] : []),
        ...(campaignId ? [`campaign.id = ${campaignId}`] : []),
        ...(adGroupId ? [`ad_group.id = ${adGroupId}`] : []),
        /* Display, Vídeo e Demand Gen não veiculam na rede de Pesquisa: viriam sem parcela e
           seriam descartadas depois, mas antes tomariam vagas do LIMIT. */
        ...(net === "SEARCH" && CHANNEL_FILTER_LEVELS.has(lvl)
          ? [`campaign.advertising_channel_type NOT IN ${gaqlList(NO_SEARCH_SHARE_CHANNELS)}`]
          : []),
        "metrics.impressions > 0",
      ];
      // Conta sem segmento é uma linha só; o resto vai com LIMIT (ordenado por custo).
      const limited = !(lvl === "account" && seg === "none");
      const client = ctx.getClient();
      const rows = await client.searchStream(
        customerId,
        `SELECT ${select.join(", ")}
         FROM ${spec.from}
         WHERE ${where.join(" AND ")}
         ORDER BY metrics.cost_micros DESC${limited ? `
         LIMIT ${maxRows}` : ""}`
      );
      const truncated = limited && rows.length >= maxRows;

      // Meta de TARGET_IMPRESSION_SHARE de estratégia de portfólio fica no bidding_strategy.
      const portfolioTargets = new Map<string, Row>();
      if (lvl === "campaign" && rows.some((r) => {
        const c = obj(r.campaign);
        return c.biddingStrategyType === "TARGET_IMPRESSION_SHARE" && !obj(c.targetImpressionShare).location && c.biddingStrategy;
      })) {
        const strategies = await client.searchStream(
          customerId,
          `SELECT bidding_strategy.resource_name, bidding_strategy.name,
                  bidding_strategy.target_impression_share.location,
                  bidding_strategy.target_impression_share.location_fraction_micros
           FROM bidding_strategy
           WHERE bidding_strategy.type = 'TARGET_IMPRESSION_SHARE'`
        );
        for (const s of strategies) {
          const strategy = obj(s.biddingStrategy);
          portfolioTargets.set(String(strategy.resourceName), obj(strategy.targetImpressionShare));
        }
      }

      let withoutShare = 0;
      const isKey = metrics[0].json;
      const out = rows
        .filter((r) => {
          // Rede/tipo de campanha sem a métrica (ex.: Display na visão SEARCH) vem sem o campo.
          const has = numOrNull(obj(r.metrics)[isKey]) !== null;
          if (!has) withoutShare++;
          return has;
        })
        .map((r) => {
          const m = obj(r.metrics);
          const c = obj(r.campaign);
          const g = obj(r.adGroup);
          const k = obj(r.adGroupCriterion);
          const s = obj(r.segments);
          const entity: Row =
            lvl === "account" ? { conta: obj(r.customer).descriptiveName ?? customerId }
              : lvl === "campaign" ? { campaign_id: c.id, campanha: c.name, tipo: c.advertisingChannelType, estrategia: c.biddingStrategyType }
                : lvl === "ad_group" ? { ad_group_id: g.id, grupo: g.name, campanha: c.name }
                  : lvl === "keyword"
                    ? { criterion_id: k.criterionId, palavra_chave: obj(k.keyword).text, correspondencia: obj(k.keyword).matchType, grupo: g.name, campanha: c.name }
                    : { item_id: s.productItemId, campanha: c.name };
          const segmentValue = segmentField ? { [seg]: s[toJsonKey(segmentField.slice("segments.".length))] } : {};
          const shares: Row = {};
          for (const metric of metrics) {
            shares[metric.label] = metric.kind === "pct"
              ? (numOrNull(m[metric.json]) === null ? null : `${round2(Number(m[metric.json]) * 100)}%`)
              : formatShare(m[metric.json], metric.kind);
          }
          const spend = microsToMoney(m.costMicros);
          const value = num(m.conversionsValue);
          const row: Row = {
            ...entity,
            ...segmentValue,
            ...shares,
            diagnostico: metrics.some((metric) => metric.label === "perdida_orcamento")
              ? impressionShareDiagnosis(
                m[isKey],
                m[net === "SEARCH" ? "searchBudgetLostImpressionShare" : "contentBudgetLostImpressionShare"],
                m[net === "SEARCH" ? "searchRankLostImpressionShare" : "contentRankLostImpressionShare"]
              )
              // content_*_lost_* não aceitam segments.hour: sem as perdas não há como apontar o gargalo.
              : "perdas não disponíveis com este segmento",
            impressoes: num(m.impressions),
            cliques: num(m.clicks),
            custo: round2(spend),
            conversoes: round2(num(m.conversions)),
            roas: spend > 0 ? round2(value / spend) : null,
          };
          if (lvl === "campaign" && c.biddingStrategyType === "TARGET_IMPRESSION_SHARE" && net === "SEARCH") {
            const target = Object.keys(obj(c.targetImpressionShare)).length
              ? obj(c.targetImpressionShare)
              : portfolioTargets.get(String(c.biddingStrategy ?? "")) ?? {};
            const location = String(target.location ?? "");
            const goal = numOrNull(target.locationFractionMicros);
            const actual = numOrNull(m[TARGET_LOCATION_METRIC[location] ?? ""]);
            row.meta_parcela = goal === null || !TARGET_LOCATION_METRIC[location]
              ? "meta não lida (estratégia de portfólio de outra conta ou sem meta)"
              : {
                local: location,
                meta: `${round2(goal / 10_000)}%`,
                atual: formatShare(actual, "share"),
                atingiu: actual === null ? null : actual >= goal / 1_000_000,
              };
          }
          return row;
        });

      /* O LIMIT escolhe pelas linhas de maior custo; com segmento de tempo a saída vai em ordem
         do período (sort estável: dentro do mesmo período continua por custo). */
      const timeOrder = TIME_SEGMENT_ORDER[seg];
      if (timeOrder) out.sort((a, b) => timeOrder(a[seg], b[seg]));

      const header = `${out.length} linha(s) — parcela de impressões ${net === "SEARCH" ? "na Pesquisa" : "na Display"}, nível ${lvl}` +
        `${seg !== "none" ? `, por ${seg}${timeOrder ? " (em ordem do período)" : ""}` : ""}.` +
        (withoutShare ? ` ${withoutShare} linha(s) sem parcela (tipo de campanha/rede sem essa métrica) foram omitidas.` : "");
      const notes = truncated
        ? [
          `Limite de ${maxRows} linha(s) atingido: a consulta trouxe só as ${maxRows} de maior custo` +
            `${timeOrder ? ` — a série por ${seg} está incompleta (faltam períodos/entidades de menor custo)` : ""}. ` +
            "Aumente limit (máx. 5000), encurte o período ou filtre por campaignId/adGroupId.",
        ]
        : [];
      return { content: [text(render(out, format, header, out, notes))] };
    }
  );

  // ── list_policy_issues ─────────────────────────────────────────────

  const APPROVAL_STATUSES = ["DISAPPROVED", "APPROVED_LIMITED", "AREA_OF_INTEREST_ONLY"] as const;

  ctx.mcp.registerTool(
    "list_policy_issues",
    {
      description: [
        "Reprovações e limitações de política: anúncios (ad_group_ad.policy_summary), assets vinculados a",
        "conta/campanha/grupo e a grupos de recursos PMax (asset.policy_summary / asset_group_asset.policy_summary)",
        "e palavras-chave reprovadas (approval_status, disapproval_reasons). Para cada item: tópico da política,",
        "efeito (não veicula / restrito), evidências (texto que violou, destino fora do ar com código HTTP e",
        "dispositivo, URLs divergentes), restrições por país e uma sugestão de correção.",
        "statuses (anúncios/assets): DISAPPROVED, APPROVED_LIMITED, AREA_OF_INTEREST_ONLY — padrão: os três.",
        "Palavras-chave entram quando DISAPPROVED está na lista. A API não permite recurso (appeal): para",
        "exceção ao criar/editar use request_ad_policy_exemption / request_keyword_policy_exemption.",
        "Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        scope: z.enum(["all", "ads", "assets", "keywords"]).optional().describe("Default: all."),
        statuses: flexArray(z.enum(APPROVAL_STATUSES)).optional().describe("Default: DISAPPROVED, APPROVED_LIMITED, AREA_OF_INTEREST_ONLY."),
        limit: z.number().optional().describe("Máximo de linhas por consulta. Default 200, máximo 2000. O cabeçalho avisa quando alguma consulta atinge o limite."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, scope, statuses, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const wanted = statuses === undefined ? [...APPROVAL_STATUSES] : ensureArray<string>(statuses).map(String);
      const invalid = wanted.filter((s) => !(APPROVAL_STATUSES as readonly string[]).includes(s));
      if (invalid.length || wanted.length === 0) {
        return fail(`statuses inválido: ${invalid.join(", ") || "(vazio)"}. Use: ${APPROVAL_STATUSES.join(", ")}.`);
      }
      const maxRows = parseLimit(limit, 200, 2000);
      if (typeof maxRows === "string") return fail(maxRows);
      const sc = scope ?? "all";
      const cid = customerId.replace(/-/g, "");
      const inList = `(${wanted.map((s) => `'${s}'`).join(", ")})`;
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const client = ctx.getClient();
      const items: Row[] = [];

      /* Cada consulta tem o próprio LIMIT: a que enche o limite é anotada para o cabeçalho avisar
         (antes o corte passava calado). */
      const truncatedIn: string[] = [];
      const fetchRows = async (label: string, query: string) => {
        const rows = await client.searchStream(customerId, query);
        if (rows.length >= maxRows) truncatedIn.push(label);
        return rows;
      };

      const policyItem = (base: Row, summary: Row): Row => ({
        ...base,
        status_aprovacao: summary.approvalStatus ?? null,
        status_revisao: summary.reviewStatus ?? null,
        topicos: arr(summary.policyTopicEntries).map(describeTopicEntry),
      });

      if (sc === "all" || sc === "ads") {
        const rows = await fetchRows(
          "anúncios",
          `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name, ad_group_ad.status,
                  ad_group_ad.ad.final_urls, ad_group_ad.policy_summary.approval_status,
                  ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries,
                  ad_group.id, ad_group.name, campaign.id, campaign.name
           FROM ad_group_ad
           WHERE ad_group_ad.policy_summary.approval_status IN ${inList}
             AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'
             AND campaign.status != 'REMOVED'${campaignFilter}
           LIMIT ${maxRows}`
        );
        for (const row of rows) {
          const a = obj(row.adGroupAd);
          const ad = obj(a.ad);
          items.push(policyItem({
            tipo: "anuncio",
            nivel: "grupo de anúncios",
            id: ad.id,
            nome: ad.name ?? ad.type,
            status: a.status,
            url_final: arr(ad.finalUrls)[0] ?? null,
            grupo: obj(row.adGroup).name,
            ad_group_id: obj(row.adGroup).id,
            campanha: obj(row.campaign).name,
            campaign_id: obj(row.campaign).id,
          }, obj(a.policySummary)));
        }
      }

      if (sc === "all" || sc === "assets") {
        const assetFields = "asset.id, asset.name, asset.type, asset.policy_summary.approval_status, asset.policy_summary.review_status, asset.policy_summary.policy_topic_entries";
        const assetBase = (row: Row, link: Row, extra: Row): Row => {
          const asset = obj(row.asset);
          return {
            tipo: "asset",
            id: asset.id,
            nome: asset.name ?? asset.type,
            tipo_asset: asset.type,
            campo: link.fieldType,
            status: link.status,
            primary_status_vinculo: link.primaryStatus ?? null,
            motivos_vinculo: arr(link.primaryStatusReasons),
            ...extra,
          };
        };
        const campaignAssets = await fetchRows(
          "assets de campanha",
          `SELECT campaign_asset.asset, campaign_asset.field_type, campaign_asset.status,
                  campaign_asset.primary_status, campaign_asset.primary_status_reasons,
                  campaign.id, campaign.name, ${assetFields}
           FROM campaign_asset
           WHERE asset.policy_summary.approval_status IN ${inList} AND campaign_asset.status != 'REMOVED'` +
            (campaignId ? ` AND campaign_asset.campaign = 'customers/${cid}/campaigns/${campaignId}'` : "") +
            ` LIMIT ${maxRows}`
        );
        for (const row of campaignAssets) {
          items.push(policyItem(assetBase(row, obj(row.campaignAsset), {
            nivel: "campanha", campanha: obj(row.campaign).name, campaign_id: obj(row.campaign).id,
          }), obj(obj(row.asset).policySummary)));
        }
        const adGroupAssets = await fetchRows(
          "assets de grupo de anúncios",
          `SELECT ad_group_asset.asset, ad_group_asset.field_type, ad_group_asset.status,
                  ad_group_asset.primary_status, ad_group_asset.primary_status_reasons,
                  ad_group.id, ad_group.name, campaign.id, campaign.name, ${assetFields}
           FROM ad_group_asset
           WHERE asset.policy_summary.approval_status IN ${inList} AND ad_group_asset.status != 'REMOVED'${campaignFilter}
           LIMIT ${maxRows}`
        );
        for (const row of adGroupAssets) {
          items.push(policyItem(assetBase(row, obj(row.adGroupAsset), {
            nivel: "grupo de anúncios", grupo: obj(row.adGroup).name, ad_group_id: obj(row.adGroup).id,
            campanha: obj(row.campaign).name, campaign_id: obj(row.campaign).id,
          }), obj(obj(row.asset).policySummary)));
        }
        // Assets da conta valem para todas as campanhas — entram mesmo com campaignId.
        const customerAssets = await fetchRows(
          "assets da conta",
          `SELECT customer_asset.asset, customer_asset.field_type, customer_asset.status,
                  customer_asset.primary_status, customer_asset.primary_status_reasons, ${assetFields}
           FROM customer_asset
           WHERE asset.policy_summary.approval_status IN ${inList} AND customer_asset.status != 'REMOVED'
           LIMIT ${maxRows}`
        );
        for (const row of customerAssets) {
          items.push(policyItem(assetBase(row, obj(row.customerAsset), { nivel: "conta" }), obj(obj(row.asset).policySummary)));
        }
        const groupAssets = await fetchRows(
          "assets de grupo de recursos (PMax)",
          `SELECT asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status,
                  asset_group_asset.primary_status, asset_group_asset.primary_status_reasons,
                  asset_group_asset.policy_summary.approval_status, asset_group_asset.policy_summary.review_status,
                  asset_group_asset.policy_summary.policy_topic_entries,
                  asset_group.id, asset_group.name, campaign.id, campaign.name, asset.id, asset.name, asset.type
           FROM asset_group_asset
           WHERE asset_group_asset.policy_summary.approval_status IN ${inList}
             AND asset_group_asset.status != 'REMOVED'${campaignFilter}
           LIMIT ${maxRows}`
        );
        for (const row of groupAssets) {
          const link = obj(row.assetGroupAsset);
          items.push(policyItem(assetBase(row, link, {
            nivel: "grupo de recursos (PMax)", grupo: obj(row.assetGroup).name, asset_group_id: obj(row.assetGroup).id,
            campanha: obj(row.campaign).name, campaign_id: obj(row.campaign).id,
          }), obj(link.policySummary)));
        }
      }

      if ((sc === "all" || sc === "keywords") && wanted.includes("DISAPPROVED")) {
        const rows = await fetchRows(
          "palavras-chave",
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                  ad_group_criterion.approval_status, ad_group_criterion.disapproval_reasons,
                  ad_group_criterion.primary_status, ad_group_criterion.primary_status_reasons,
                  ad_group.id, ad_group.name, campaign.id, campaign.name
           FROM ad_group_criterion
           WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
             AND ad_group_criterion.approval_status = 'DISAPPROVED'
             AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'
             AND campaign.status != 'REMOVED'${campaignFilter}
           LIMIT ${maxRows}`
        );
        for (const row of rows) {
          const k = obj(row.adGroupCriterion);
          const kw = obj(k.keyword);
          const reasons = arr(k.disapprovalReasons).map(String);
          items.push({
            tipo: "palavra-chave",
            nivel: "grupo de anúncios",
            id: k.criterionId,
            nome: `[${String(kw.matchType ?? "")}] ${String(kw.text ?? "")}`,
            status: k.status,
            grupo: obj(row.adGroup).name,
            ad_group_id: obj(row.adGroup).id,
            campanha: obj(row.campaign).name,
            campaign_id: obj(row.campaign).id,
            status_aprovacao: k.approvalStatus,
            motivos_reprovacao: reasons,
            topicos: [],
            sugestao: "Palavra-chave já salva não tem pedido de exceção pela API: remova e recrie com request_keyword_policy_exemption (se a política for passível de exceção) ou troque o texto.",
          });
        }
      }

      const summary = {
        anuncios: items.filter((i) => i.tipo === "anuncio").length,
        assets: items.filter((i) => i.tipo === "asset").length,
        palavras_chave: items.filter((i) => i.tipo === "palavra-chave").length,
        ...(truncatedIn.length ? { limite_atingido_em: truncatedIn, limite_por_consulta: maxRows } : {}),
      };
      const notes = truncatedIn.length
        ? [`Limite de ${maxRows} linha(s) por consulta atingido em: ${truncatedIn.join(", ")} — pode haver mais itens; ` +
          "aumente limit (máx. 2000) ou filtre por campaignId/scope/statuses."]
        : [];
      const flat = items.map((item) => ({
        tipo: item.tipo,
        nivel: item.nivel,
        id: item.id,
        nome: item.nome,
        campanha: item.campanha ?? "",
        grupo: item.grupo ?? "",
        status_aprovacao: item.status_aprovacao,
        topicos: arr(item.topicos).map((t) => `${String(obj(t).topico)}(${String(obj(t).tipo)})`).join(" | ") ||
          arr(item.motivos_reprovacao).join(" | "),
        evidencias: arr(item.topicos).flatMap((t) => arr(obj(t).evidencias)).join(" | "),
      }));
      const header = `${items.length} item(ns) com problema de política (${summary.anuncios} anúncio(s), ${summary.assets} asset(s), ` +
        `${summary.palavras_chave} palavra(s)-chave).`;
      return { content: [text(render(flat, format, header, { resumo: summary, itens: items }, notes))] };
    }
  );

  // ── request_keyword_policy_exemption ───────────────────────────────

  ctx.mcp.registerTool(
    "request_keyword_policy_exemption",
    {
      description: [
        "Cria uma palavra-chave pedindo exceção de política (exempt_policy_violation_keys) — ex.: marca de",
        "terceiro para revendedor autorizado, termos de saúde/farmácia. WRITE OPERATION, em duas etapas:",
        "1) sem confirm: valida na API (validate_only, nada gravado) e lista as violações que ela aponta —",
        "   nome da política, texto que violou e se admite exceção (is_exemptible);",
        "2) confirm: true + exemptPolicies com os nomes de TODAS as políticas listadas: cria a palavra-chave",
        "   com a exceção. Violação sem exceção possível é recusada — troque o texto.",
        "A palavra-chave fica salva, mas pode não veicular até a revisão do Google. Sem violação, use create_keyword.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID (numérico)."),
        keyword: z.string().describe("Texto da palavra-chave (até 80 caracteres e 10 palavras)."),
        matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).describe("Tipo de correspondência."),
        cpcBidMicros: z.number().optional().describe("Lance de CPC em micros (opcional; só vale com lance manual)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Status da palavra-chave criada. Default: ENABLED."),
        exemptPolicies: flexArray(z.string()).optional().describe("Nomes das políticas (policy_name) que o usuário confirmou."),
        confirm: z.boolean().optional().describe("true = envia o pedido de exceção. Sem isso, só valida e mostra as violações."),
      },
    },
    async ({ customerId, adGroupId, keyword, matchType, cpcBidMicros, status, exemptPolicies, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!NUMERIC_ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      const kwText = keyword.trim().replace(/\s+/g, " ");
      if (!kwText) return fail("keyword vazia.");
      if (kwText.length > 80 || kwText.split(" ").length > 10) {
        return fail(`keyword fora do limite do Google Ads (80 caracteres e 10 palavras): "${kwText}".`);
      }
      if (!["EXACT", "PHRASE", "BROAD"].includes(matchType)) return fail(`matchType inválido: ${matchType}.`);
      if (cpcBidMicros !== undefined && (!isPositiveMicros(cpcBidMicros) || cpcBidMicros < LOW_BID_MICROS)) {
        return fail(`cpcBidMicros inválido: ${cpcBidMicros}. Use micros inteiros ≥ ${LOW_BID_MICROS} (R$ ${(LOW_BID_MICROS / 1_000_000).toFixed(2)}).`);
      }
      const confirmed = ensureArray<string>(exemptPolicies ?? []).map((p) => String(p).trim().toUpperCase()).filter(Boolean);
      const cid = customerId.replace(/-/g, "");
      const client = ctx.getClient();

      const [group] = await client.searchStream(
        customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`
      );
      if (!group) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${customerId}.`);
      const g = obj(group.adGroup);
      if (g.status === "REMOVED") return fail(`Grupo de anúncios ${adGroupId} está removido.`);

      const existing = await client.searchStream(
        customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.approval_status
         FROM ad_group_criterion
         WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.type = 'KEYWORD'
           AND ad_group_criterion.negative = false AND ad_group_criterion.status != 'REMOVED'
           AND ad_group_criterion.keyword.match_type = '${matchType}'
           AND ad_group_criterion.keyword.text = '${gaqlLiteral(kwText)}'`
      );
      const dup = existing.find((row) => String(obj(obj(row.adGroupCriterion).keyword).text ?? "").toLowerCase() === kwText.toLowerCase());
      if (dup) {
        const k = obj(dup.adGroupCriterion);
        return {
          content: [text(`Nada a fazer: [${matchType}] "${kwText}" já existe no grupo ${adGroupId} (criterion ${String(k.criterionId)}, ` +
            `status ${String(k.status)}, aprovação ${String(k.approvalStatus ?? "?")}). Palavra-chave já salva não recebe pedido de exceção pela API.`)],
        };
      }

      const create: Row = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: status ?? "ENABLED",
        keyword: { text: kwText, matchType },
        ...(cpcBidMicros !== undefined ? { cpcBidMicros: String(cpcBidMicros) } : {}),
      };
      const preflight = await validateWithDetails(client, customerId, "adGroupCriteria", { create });
      if ("thrown" in preflight) {
        return fail(`A validação prévia falhou e a API não devolveu os detalhes estruturados da política: ${preflight.thrown}\nNada foi gravado.`);
      }
      const violations = preflight.errors.filter((e) => e.violation);
      const others = preflight.errors.filter((e) => !e.violation);
      if (others.length) {
        return fail(`A API recusou a palavra-chave por motivo que não é exceção de política — nada foi gravado:\n- ${others.map(errorLine).join("\n- ")}`);
      }
      if (violations.length === 0) {
        return {
          content: [text(`Nenhuma violação de política para [${matchType}] "${kwText}" — não há exceção a pedir. Crie com create_keyword. Nada foi gravado.`)],
        };
      }
      const list = violations.map((e) => ({
        politica: e.violation!.policyName,
        nome: e.violation!.externalPolicyName ?? null,
        descricao: e.violation!.description ?? null,
        texto_violado: e.violation!.violatingText ?? null,
        admite_excecao: e.violation!.isExemptible,
      }));
      const notExemptible = list.filter((v) => !v.admite_excecao);
      if (notExemptible.length) {
        return fail(`Há violação que não admite exceção (${notExemptible.map((v) => v.politica).join(", ")}): troque o texto da palavra-chave. Nada foi gravado.\n\n${formatJson(list)}`);
      }
      const required = [...new Set(list.map((v) => v.politica.toUpperCase()))];
      const missing = required.filter((p) => !confirmed.includes(p));
      if (confirm !== true || missing.length) {
        return {
          content: [text(
            `Validação: [${matchType}] "${kwText}" viola ${required.length} política(s), todas passíveis de exceção. Nada foi gravado.\n` +
              `Para pedir a exceção, confirme com o usuário e chame de novo com confirm: true e exemptPolicies: ${JSON.stringify(required)}` +
              `${missing.length && confirm === true ? ` (faltou confirmar: ${missing.join(", ")})` : ""}.\n\n${formatJson(list)}`
          )],
        };
      }

      const keys = [...new Map(violations.map((e) => {
        const key = { policyName: e.violation!.policyName, ...(e.violation!.violatingText !== undefined ? { violatingText: e.violation!.violatingText } : {}) };
        return [`${key.policyName}|${key.violatingText ?? ""}`, key] as const;
      })).values()];
      const response = await client.mutate(
        customerId,
        "adGroupCriteria",
        [{ create, exemptPolicyViolationKeys: keys } as unknown as MutateOperation],
        { partialFailure: true }
      );
      const errors = parseAdsFailure(response.partialFailureError);
      if (errors.length) {
        return fail(`A API recusou o pedido de exceção:\n- ${errors.map(errorLine).join("\n- ")}\nNada foi gravado.`);
      }
      if (client.isDryRun) {
        return { content: [text(`Validado com a exceção (${required.join(", ")}) — modo validação, nada foi gravado.\n\n${formatJson({ create, exemptPolicyViolationKeys: keys })}`)] };
      }
      const resourceName = String(obj(arr(response.results)[0]).resourceName ?? "");
      return {
        content: [text(
          `Palavra-chave [${matchType}] "${kwText}" criada no grupo ${adGroupId} com pedido de exceção (${required.join(", ")}). ` +
            `Ela fica salva, mas pode não veicular até a revisão do Google — acompanhe com list_policy_issues.\n\n${formatJson({ resourceName, exemptPolicyViolationKeys: keys })}`
        )],
      };
    }
  );

  // ── request_ad_policy_exemption ────────────────────────────────────

  ctx.mcp.registerTool(
    "request_ad_policy_exemption",
    {
      description: [
        "Cria um anúncio responsivo de pesquisa (RSA) — ou altera o texto/URL de um RSA existente — pedindo",
        "exceção de política (policy_validation_parameter.ignorable_policy_topics). WRITE OPERATION em duas etapas:",
        "1) sem confirm: valida na API (validate_only, nada gravado) e lista os tópicos de política que ela",
        "   aponta (ex.: TRADEMARKS_IN_AD_TEXT), com tipo e evidências;",
        "2) confirm: true + ignorablePolicyTopics com TODOS os tópicos listados: envia com a exceção.",
        "Criação: adGroupId + finalUrl + headlines (3-15, até 30 caracteres) + descriptions (2-4, até 90); nasce PAUSED.",
        "Edição: adId + só os campos a mudar (headlines/descriptions substituem todos; pins de títulos iguais são mantidos).",
        "Só erros de achado de política (PolicyFindingError) admitem exceção; outros erros param o fluxo.",
        "Sem achado de política, use create_ad / update_ad.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().optional().describe("Grupo onde criar o RSA (ID numérico). Obrigatório sem adId."),
        adId: z.string().optional().describe("RSA existente a editar (ID numérico). Sem ele, cria um novo."),
        finalUrl: z.string().optional().describe("URL final (http/https)."),
        headlines: flexArray(z.string()).optional().describe("Títulos (3-15, até 30 caracteres cada)."),
        descriptions: flexArray(z.string()).optional().describe("Descrições (2-4, até 90 caracteres cada)."),
        path1: z.string().optional().describe("Caminho 1 do URL de exibição (até 15 caracteres)."),
        path2: z.string().optional().describe("Caminho 2 do URL de exibição (até 15 caracteres)."),
        ignorablePolicyTopics: flexArray(z.string()).optional().describe("Tópicos (PolicyTopicEntry.topic) que o usuário confirmou."),
        confirm: z.boolean().optional().describe("true = envia com a exceção. Sem isso, só valida e mostra os tópicos."),
      },
    },
    async ({ customerId, adGroupId, adId, finalUrl, headlines, descriptions, path1, path2, ignorablePolicyTopics, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (adId !== undefined && !NUMERIC_ID.test(adId)) return fail(`adId deve ser numérico, recebido "${adId}".`);
      if (adGroupId !== undefined && !NUMERIC_ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      if (adId === undefined && adGroupId === undefined) return fail("Informe adGroupId (criar RSA) ou adId (editar RSA).");
      const heads = headlines === undefined ? undefined : ensureArray<string>(headlines).map((h) => String(h).trim());
      const descs = descriptions === undefined ? undefined : ensureArray<string>(descriptions).map((d) => String(d).trim());
      const problems: string[] = [];
      if (heads) {
        if (heads.length < 3 || heads.length > 15) problems.push(`headlines: ${heads.length} (precisa de 3 a 15)`);
        heads.filter((h) => !h || h.length > 30).forEach((h) => problems.push(`título vazio ou com mais de 30 caracteres: "${h}"`));
      }
      if (descs) {
        if (descs.length < 2 || descs.length > 4) problems.push(`descriptions: ${descs.length} (precisa de 2 a 4)`);
        descs.filter((d) => !d || d.length > 90).forEach((d) => problems.push(`descrição vazia ou com mais de 90 caracteres: "${d}"`));
      }
      for (const [name, value] of [["path1", path1], ["path2", path2]] as const) {
        if (value !== undefined && value.length > 15) problems.push(`${name} com mais de 15 caracteres: "${value}"`);
      }
      if (finalUrl !== undefined) {
        let ok = false;
        try {
          ok = ["http:", "https:"].includes(new URL(finalUrl).protocol);
        } catch {
          ok = false;
        }
        if (!ok) problems.push(`finalUrl inválida: "${finalUrl}"`);
      }
      const isCreate = adId === undefined;
      if (isCreate && (!finalUrl || !heads || !descs)) problems.push("para criar o RSA informe finalUrl, headlines e descriptions");
      if (!isCreate && finalUrl === undefined && !heads && !descs && path1 === undefined && path2 === undefined) {
        problems.push("para editar o RSA informe ao menos um campo (finalUrl, headlines, descriptions, path1, path2)");
      }
      if (problems.length) return fail(`Parâmetros inválidos — nada enviado:\n- ${problems.join("\n- ")}`);
      const confirmedTopics = ensureArray<string>(ignorablePolicyTopics ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
      const cid = customerId.replace(/-/g, "");
      const client = ctx.getClient();

      let resource: string;
      let operation: Row;
      let before: Row | undefined;
      let changed: string[] = [];
      if (isCreate) {
        const [group] = await client.searchStream(
          customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name
           FROM ad_group
           WHERE ad_group.id = ${adGroupId}`
        );
        if (!group) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${customerId}.`);
        if (obj(group.adGroup).status === "REMOVED") return fail(`Grupo de anúncios ${adGroupId} está removido.`);
        resource = "adGroupAds";
        operation = {
          create: {
            adGroup: `customers/${cid}/adGroups/${adGroupId}`,
            status: "PAUSED",
            ad: {
              finalUrls: [finalUrl],
              responsiveSearchAd: {
                headlines: heads!.map((h) => ({ text: h })),
                descriptions: descs!.map((d) => ({ text: d })),
                ...(path1 ? { path1 } : {}),
                ...(path2 ? { path2 } : {}),
              },
            },
          },
        };
      } else {
        const [current] = await client.searchStream(
          customerId,
          `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad.final_urls,
                  ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
                  ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
                  ad_group_ad.policy_summary.approval_status, ad_group.id
           FROM ad_group_ad
           WHERE ad_group_ad.ad.id = ${adId} AND ad_group_ad.status != 'REMOVED'` +
            (adGroupId ? ` AND ad_group.id = ${adGroupId}` : "")
        );
        if (!current) return fail(`Anúncio ${adId} não encontrado (ou removido) na conta ${customerId}.`);
        const ad = obj(obj(current.adGroupAd).ad);
        if (ad.type !== "RESPONSIVE_SEARCH_AD") return fail(`Anúncio ${adId} é ${String(ad.type)} — esta tool só edita RSA.`);
        const rsa = obj(ad.responsiveSearchAd);
        const texts = (list: unknown) => arr(list).map((a) => String(obj(a).text ?? ""));
        before = {
          final_url: arr(ad.finalUrls)[0] ?? null,
          headlines: texts(rsa.headlines),
          descriptions: texts(rsa.descriptions),
          path1: rsa.path1 ?? "",
          path2: rsa.path2 ?? "",
        };
        const update: Row = { resourceName: `customers/${cid}/ads/${adId}` };
        const rsaUpdate: Row = {};
        const keepPins = (list: unknown, next: string[]) => {
          const pins = new Map(arr(list).map((a) => [String(obj(a).text ?? ""), obj(a).pinnedField]));
          return next.map((t) => (pins.get(t) ? { text: t, pinnedField: pins.get(t) } : { text: t }));
        };
        if (finalUrl !== undefined && finalUrl !== before.final_url) {
          update.finalUrls = [finalUrl];
          changed.push("final_urls");
        }
        if (heads && JSON.stringify(heads) !== JSON.stringify(before.headlines)) {
          rsaUpdate.headlines = keepPins(rsa.headlines, heads);
          changed.push("responsive_search_ad.headlines");
        }
        if (descs && JSON.stringify(descs) !== JSON.stringify(before.descriptions)) {
          rsaUpdate.descriptions = keepPins(rsa.descriptions, descs);
          changed.push("responsive_search_ad.descriptions");
        }
        if (path1 !== undefined && path1 !== before.path1) {
          rsaUpdate.path1 = path1;
          changed.push("responsive_search_ad.path1");
        }
        if (path2 !== undefined && path2 !== before.path2) {
          rsaUpdate.path2 = path2;
          changed.push("responsive_search_ad.path2");
        }
        if (changed.length === 0) {
          return { content: [text(`Nada a fazer: o anúncio ${adId} já tem esses valores. Nada foi enviado.`)] };
        }
        if (Object.keys(rsaUpdate).length) update.responsiveSearchAd = rsaUpdate;
        resource = "ads";
        operation = { update, updateMask: changed.join(",") };
      }

      const preflight = await validateWithDetails(client, customerId, resource, operation);
      if ("thrown" in preflight) {
        return fail(`A validação prévia falhou e a API não devolveu os detalhes estruturados da política: ${preflight.thrown}\nNada foi gravado.`);
      }
      const findings = preflight.errors.filter((e) => e.findings?.length);
      const others = preflight.errors.filter((e) => !e.findings?.length);
      if (others.length) {
        return fail(`A API recusou o anúncio por motivo que não é achado de política (sem exceção possível) — nada foi gravado:\n- ${others.map(errorLine).join("\n- ")}`);
      }
      if (findings.length === 0) {
        return {
          content: [text(`Nenhum achado de política bloqueando o anúncio — não há exceção a pedir. Use ${isCreate ? "create_ad" : "update_ad"}. Nada foi gravado.`)],
        };
      }
      const entries = findings.flatMap((e) => e.findings!.map((entry) => ({ ...describeTopicEntry(entry), gatilho: e.trigger ?? null, campo: e.fieldPath ?? null })));
      const topics = [...new Set(entries.map((e) => e.topico).filter(Boolean))];
      const missing = topics.filter((t) => !confirmedTopics.includes(t.toUpperCase()));
      if (confirm !== true || missing.length) {
        return {
          content: [text(
            `Validação: o anúncio esbarra em ${topics.length} tópico(s) de política. Nada foi gravado.\n` +
              `Para pedir a exceção, confirme com o usuário e chame de novo com confirm: true e ignorablePolicyTopics: ${JSON.stringify(topics)}` +
              `${missing.length && confirm === true ? ` (faltou confirmar: ${missing.join(", ")})` : ""}.\n\n${formatJson({ ...(before ? { antes: before, campos: changed } : {}), topicos: entries })}`
          )],
        };
      }

      const response = await client.mutate(
        customerId,
        resource,
        [{ ...operation, policyValidationParameter: { ignorablePolicyTopics: topics } } as unknown as MutateOperation],
        { partialFailure: true }
      );
      const errors = parseAdsFailure(response.partialFailureError);
      if (errors.length) {
        return fail(`A API recusou o pedido de exceção:\n- ${errors.map(errorLine).join("\n- ")}\nNada foi gravado.`);
      }
      if (client.isDryRun) {
        return { content: [text(`Validado com a exceção (${topics.join(", ")}) — modo validação, nada foi gravado.\n\n${formatJson(operation)}`)] };
      }
      const resourceName = String(obj(arr(response.results)[0]).resourceName ?? "");
      return {
        content: [text(
          `${isCreate ? `RSA criado (PAUSED) no grupo ${adGroupId}` : `Anúncio ${adId} atualizado (${changed.join(", ")})`} com pedido de exceção ` +
            `(${topics.join(", ")}). Ele pode não veicular até a revisão do Google — acompanhe com list_policy_issues.\n\n` +
            formatJson({ resourceName, ...(before ? { antes: before } : {}), ignorablePolicyTopics: topics })
        )],
      };
    }
  );
}
