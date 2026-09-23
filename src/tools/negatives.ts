/**
 * Lote negatives: palavras-chave negativas em todos os níveis.
 *
 * - grupo de anúncios (AdGroupCriterion negative=true) e campanha (CampaignCriterion
 *   negative=true — inclusive Performance Max, até 10.000 por campanha);
 * - listas compartilhadas (SharedSet NEGATIVE_KEYWORDS + SharedCriterion), vinculadas a
 *   campanhas por CampaignSharedSet — também as listas de um MCC gestor;
 * - a lista de nível de conta (SharedSet ACCOUNT_LEVEL_NEGATIVE_KEYWORDS), vinculada à conta
 *   por CustomerNegativeCriterion.negative_keyword_list — uma só por conta.
 *
 * As quatro tools antigas (add_negative_keyword, list_negative_keywords,
 * remove_negative_keyword, create_shared_negative_list) saíram de src/tools.ts e vivem aqui;
 * continuam classificadas no núcleo de src/read-only.ts. As novas estão em
 * negatives.catalog.ts. Tools de leitura chamam checkCustomerAccess (o teste de allowlist
 * confere no código-fonte).
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
  gaqlLiteral,
  partialFailureByOperation,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Limites (fontes em docs/batches/negatives.md) ─────────────────────

export const NEGATIVE_LIMITS = {
  /** KeywordInfo.text (common/criteria.proto v25): "at most 80 characters and 10 words". */
  keywordChars: 80,
  keywordWords: 10,
  /** Negativas por campanha (Pesquisa e Performance Max). */
  perCampaign: 10_000,
  /** Display e Vídeo só consideram as primeiras 1.000 negativas. */
  displayVideoConsidered: 1_000,
  /** Palavras por lista compartilhada (conta ou MCC). */
  perSharedList: 5_000,
  /** Negativas de nível de conta. */
  accountLevel: 1_000,
  /** Listas de negativas por conta. */
  listsPerAccount: 20,
  /** Operações por requisição de mutate. */
  operationsPerRequest: 10_000,
  /** Acima disso, remover negativas de uma campanha/grupo exige confirm. */
  bulkRemoveWithoutConfirm: 20,
};

const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
type MatchType = (typeof MATCH_TYPES)[number];
const matchTypeSchema = z.enum(MATCH_TYPES);
const keywordSchema = z.object({
  text: z.string().describe("Texto da negativa, sem [ ], aspas ou '-' (até 80 caracteres e 10 palavras)."),
  matchType: matchTypeSchema.describe("EXACT, PHRASE ou BROAD."),
});

const ID = /^\d+$/;
const DISPLAY_VIDEO_CHANNELS = new Set(["DISPLAY", "VIDEO"]);
const ACCOUNT_LIST_DEFAULT_NAME = "Negativas da conta";
const KEYWORD_SET_TYPES = new Set(["NEGATIVE_KEYWORDS", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"]);
const CAMPAIGN_ATTACHABLE_TYPES = new Set(["NEGATIVE_KEYWORDS", "NEGATIVE_PLACEMENTS"]);

interface NegativeKeyword {
  text: string;
  matchType: MatchType;
}

interface ExistingNegative {
  criterionId: string;
  resourceName: string;
  text: string;
  matchType: string;
}

interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  channel: string;
}

interface AdGroupInfo {
  id: string;
  name: string;
  status: string;
  campaignId: string;
  campaignName: string;
  channel: string;
}

interface SharedSetInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  memberCount: number;
  referenceCount: number;
  resourceName: string;
}

// ── Texto das negativas ───────────────────────────────────────────────

const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();
const keywordKey = (k: { text: string; matchType: string }) => `${k.matchType}|${cleanText(k.text).toLowerCase()}`;
const describeKeyword = (k: { text: string; matchType: string }) => `-[${k.matchType}] "${k.text}"`;
const cleanCid = (customerId: string) => customerId.replace(/-/g, "");

function keywordTextProblem(value: string): string | null {
  if (!value) return "texto vazio";
  if (/^[-+]/.test(value)) return "não use '-' ou '+' no texto — a negativa já é uma exclusão; envie só o termo";
  if (/^\[.*\]$/.test(value) || /^".*"$/.test(value)) {
    return "não use [ ] nem aspas no texto — a correspondência vai em matchType";
  }
  if (value.length > NEGATIVE_LIMITS.keywordChars) return `mais de ${NEGATIVE_LIMITS.keywordChars} caracteres (${value.length})`;
  const words = value.split(" ").length;
  if (words > NEGATIVE_LIMITS.keywordWords) return `mais de ${NEGATIVE_LIMITS.keywordWords} palavras (${words})`;
  return null;
}

/** Valida e deduplica [{text, matchType}] (vindos do schema ou de uma string JSON). */
function parseKeywords(raw: unknown[]): { keywords: NegativeKeyword[]; duplicates: string[]; invalid: string[] } {
  const keywords: NegativeKeyword[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      invalid.push(`item ${index + 1}: esperado {text, matchType}`);
      return;
    }
    const obj = item as Row;
    const value = typeof obj.text === "string" ? cleanText(obj.text) : "";
    const matchType = typeof obj.matchType === "string" ? obj.matchType.trim().toUpperCase() : "";
    if (!(MATCH_TYPES as readonly string[]).includes(matchType)) {
      invalid.push(`item ${index + 1} ("${value}"): matchType deve ser EXACT, PHRASE ou BROAD (recebido "${String(obj.matchType ?? "")}")`);
      return;
    }
    const problem = keywordTextProblem(value);
    if (problem) {
      invalid.push(`item ${index + 1} ("${value}"): ${problem}`);
      return;
    }
    const keyword = { text: value, matchType: matchType as MatchType };
    const key = keywordKey(keyword);
    if (seen.has(key)) {
      duplicates.push(describeKeyword(keyword));
      return;
    }
    seen.add(key);
    keywords.push(keyword);
  });
  return { keywords, duplicates, invalid };
}

function parseIds(raw: unknown): { ids: string[]; bad: string[] } {
  const values = ensureArray<unknown>(raw).map((v) => String(v).trim()).filter(Boolean);
  return { ids: [...new Set(values.filter((v) => ID.test(v)))], bad: values.filter((v) => !ID.test(v)) };
}

/** ID numérico (lista desta conta) ou customers/{cid}/sharedSets/{id} (lista de outra conta, ex.: o MCC). */
function parseSharedSetRef(
  value: string,
  cid: string
): { owner: string; id: string; resourceName: string } | { error: string } {
  const v = value.trim();
  if (ID.test(v)) return { owner: cid, id: v, resourceName: `customers/${cid}/sharedSets/${v}` };
  const match = /^customers\/([\d-]+)\/sharedSets\/(\d+)$/.exec(v);
  if (!match) {
    return { error: `sharedSetId inválido: "${value}". Use o ID numérico da lista ou o resource name customers/{customerId}/sharedSets/{id}.` };
  }
  const owner = match[1].replace(/-/g, "");
  return { owner, id: match[2], resourceName: `customers/${owner}/sharedSets/${match[2]}` };
}

const ownerOf = (resourceName: string) => /^customers\/(\d+)\//.exec(resourceName)?.[1] ?? "";
const lastId = (resourceName: string) => resourceName.split("/").pop() ?? "";

// ── Erros da API ──────────────────────────────────────────────────────

/** Dicas em PT-BR para os códigos de erro dos protos v25 (errors/*.proto). */
const ERROR_HINTS: Array<[RegExp, string]> = [
  [/CUSTOMER_CANNOT_CREATE_SHARED_SET_OF_THIS_TYPE|cannot create this type of shared set/i,
    "a API não deixa esta conta criar esse tipo de lista. Para a lista de nível de conta, crie-a na interface do Google Ads (negativas da conta) e rode de novo — a tool passa a usar a lista existente."],
  [/DUPLICATE_NAME|shared set with this name already exists/i,
    "já existe uma lista ativa com esse nome — use outro nome ou edite a existente com update_shared_set_members."],
  [/SHARED_SET_REMOVED|Removed shared sets cannot be mutated/i, "a lista foi removida e não aceita mudanças."],
  [/SHARED_SET_ACCESS_DENIED|permission isn't granted/i,
    "a lista é de outra conta sem permissão — só listas do MCC gestor desta conta podem ser vinculadas."],
  [/CANNOT_HAVE_MULTIPLE_NEGATIVE_KEYWORD_LIST_PER_ACCOUNT|one Negative Keyword List per account/i,
    "a conta aceita UMA lista de negativas de nível de conta — desvincule a atual (detach_shared_set com fromAccount) antes."],
  [/NEGATIVE_KEYWORD_SHARED_SET_DOES_NOT_EXIST|CANNOT_ADD_REMOVED_NEGATIVE_KEYWORD_SHARED_SET/i,
    "a lista informada não existe ou foi removida."],
  [/CRITERION_TYPE_NOT_ALLOWED_FOR_SHARED_SET_TYPE|not appropriate for the shared set type/i,
    "esse tipo de item não cabe nesse tipo de lista (palavras-chave só em listas de palavras-chave)."],
  [/KEYWORD_HAS_INVALID_CHARS|invalid characters or symbols/i, "o texto tem símbolos que o Google não aceita em palavras-chave."],
  [/KEYWORD_TEXT_TOO_LONG|KEYWORD_HAS_TOO_MANY_WORDS/i, "máximo de 80 caracteres e 10 palavras."],
  [/RESOURCE_NOT_FOUND|Resource was not found/i, "o recurso não existe (ou foi removido) nesta conta."],
];

function withHint(message: string): string {
  const hint = ERROR_HINTS.find(([pattern]) => pattern.test(message));
  return hint ? `${message} → ${hint[1]}` : message;
}

/** Resultado por operação de um mutate com partialFailure. */
function perOperation<T>(response: Row, items: T[], dryRun: boolean) {
  const results = (response.results as Row[]) ?? [];
  const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, items.length);
  const ok: T[] = [];
  const failed: Array<{ item: T; error: string }> = [];
  items.forEach((item, index) => {
    const errors = byIndex.get(index);
    if (errors) failed.push({ item, error: withHint(errors.join("; ")) });
    else if (!dryRun && !results[index]?.resourceName) failed.push({ item, error: "a API não confirmou a operação" });
    else ok.push(item);
  });
  return { ok, failed, unattributed: unattributed.map(withHint) };
}

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });

function preview(message: string, payload: Row): ToolResult {
  return {
    content: [text(`PRÉVIA — nada foi gravado. ${message}\nEnvie confirm: true para aplicar (ou validateOnly: true para só validar na API).\n\n${formatJson(payload)}`)],
    isError: true,
  };
}

// ── Leituras ──────────────────────────────────────────────────────────

async function readCampaigns(client: GoogleAdsClient, customerId: string, ids: string[]): Promise<Map<string, CampaignInfo>> {
  const found = new Map<string, CampaignInfo>();
  if (ids.length === 0) return found;
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
     FROM campaign
     WHERE campaign.id IN (${ids.join(", ")})`);
  for (const row of rows) {
    const c = (row.campaign ?? {}) as Row;
    const id = String(c.id ?? "");
    if (id) found.set(id, { id, name: String(c.name ?? ""), status: String(c.status ?? ""), channel: String(c.advertisingChannelType ?? "") });
  }
  return found;
}

async function readAdGroup(client: GoogleAdsClient, customerId: string, adGroupId: string): Promise<AdGroupInfo | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.advertising_channel_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  const row = rows[0];
  if (!row) return undefined;
  const g = (row.adGroup ?? {}) as Row;
  const c = (row.campaign ?? {}) as Row;
  return {
    id: String(g.id ?? adGroupId),
    name: String(g.name ?? ""),
    status: String(g.status ?? ""),
    campaignId: String(c.id ?? ""),
    campaignName: String(c.name ?? ""),
    channel: String(c.advertisingChannelType ?? ""),
  };
}

function toExisting(criterion: Row | undefined): ExistingNegative {
  const c = criterion ?? {};
  const keyword = (c.keyword ?? {}) as Row;
  return {
    criterionId: String(c.criterionId ?? ""),
    resourceName: String(c.resourceName ?? ""),
    text: String(keyword.text ?? ""),
    matchType: String(keyword.matchType ?? ""),
  };
}

async function readCampaignNegatives(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<ExistingNegative[]> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.resource_name,
            campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
     FROM campaign_criterion
     WHERE campaign.id = ${campaignId}
       AND campaign_criterion.type = 'KEYWORD'
       AND campaign_criterion.negative = true
       AND campaign_criterion.status != 'REMOVED'`);
  return rows.map((row) => toExisting(row.campaignCriterion as Row));
}

async function readAdGroupNegatives(client: GoogleAdsClient, customerId: string, adGroupId: string): Promise<ExistingNegative[]> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name,
            ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
     FROM ad_group_criterion
     WHERE ad_group.id = ${adGroupId}
       AND ad_group_criterion.type = 'KEYWORD'
       AND ad_group_criterion.negative = true
       AND ad_group_criterion.status != 'REMOVED'`);
  return rows.map((row) => toExisting(row.adGroupCriterion as Row));
}

function toSharedSet(row: Row): SharedSetInfo {
  const s = (row.sharedSet ?? {}) as Row;
  return {
    id: String(s.id ?? ""),
    name: String(s.name ?? ""),
    type: String(s.type ?? ""),
    status: String(s.status ?? ""),
    memberCount: Number(s.memberCount ?? 0) || 0,
    referenceCount: Number(s.referenceCount ?? 0) || 0,
    resourceName: String(s.resourceName ?? ""),
  };
}

const SHARED_SET_FIELDS = `shared_set.id, shared_set.name, shared_set.type, shared_set.status,
            shared_set.member_count, shared_set.reference_count, shared_set.resource_name`;

async function readSharedSet(client: GoogleAdsClient, ownerCid: string, id: string): Promise<SharedSetInfo | undefined> {
  const rows = await client.searchStream(ownerCid, `SELECT ${SHARED_SET_FIELDS} FROM shared_set WHERE shared_set.id = ${id}`);
  return rows[0] ? toSharedSet(rows[0]) : undefined;
}

async function readSharedSetKeywords(client: GoogleAdsClient, ownerCid: string, id: string): Promise<ExistingNegative[]> {
  const rows = await client.searchStream(ownerCid,
    `SELECT shared_set.id, shared_criterion.criterion_id, shared_criterion.resource_name,
            shared_criterion.keyword.text, shared_criterion.keyword.match_type
     FROM shared_criterion
     WHERE shared_set.id = ${id}
       AND shared_criterion.type = 'KEYWORD'`);
  return rows.map((row) => toExisting(row.sharedCriterion as Row));
}

interface AccountListLink {
  resourceName: string;
  criterionId: string;
  sharedSet: string;
}

/** Vínculos CustomerNegativeCriterion do tipo NEGATIVE_KEYWORD_LIST (a API aceita um por conta). */
async function readAccountListLinks(client: GoogleAdsClient, customerId: string): Promise<AccountListLink[]> {
  const rows = await client.searchStream(customerId,
    `SELECT customer_negative_criterion.id, customer_negative_criterion.resource_name,
            customer_negative_criterion.negative_keyword_list.shared_set
     FROM customer_negative_criterion
     WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'`);
  return rows.map((row) => {
    const c = (row.customerNegativeCriterion ?? {}) as Row;
    return {
      resourceName: String(c.resourceName ?? ""),
      criterionId: String(c.id ?? ""),
      sharedSet: String(((c.negativeKeywordList ?? {}) as Row).sharedSet ?? ""),
    };
  });
}

/** Vínculos ativos de uma lista com campanhas desta conta (opcionalmente só algumas campanhas). */
async function readCampaignLinks(
  client: GoogleAdsClient,
  customerId: string,
  sharedSetResource: string,
  campaignIds?: string[]
): Promise<Array<{ campaignId: string; campaignName: string; resourceName: string }>> {
  const campaignFilter = campaignIds && campaignIds.length ? ` AND campaign.id IN (${campaignIds.join(", ")})` : "";
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign_shared_set.resource_name, campaign_shared_set.status
     FROM campaign_shared_set
     WHERE campaign_shared_set.shared_set = '${gaqlLiteral(sharedSetResource)}'
       AND campaign_shared_set.status = 'ENABLED'${campaignFilter}`);
  return rows.map((row) => {
    const c = (row.campaign ?? {}) as Row;
    const link = (row.campaignSharedSet ?? {}) as Row;
    return { campaignId: String(c.id ?? ""), campaignName: String(c.name ?? ""), resourceName: String(link.resourceName ?? "") };
  });
}

// ── Registro ──────────────────────────────────────────────────────────

export function registerNegativesTools(ctx: ToolContext): void {
  // ── Leitura ─────────────────────────────────────────────────────────

  ctx.mcp.registerTool(
    "list_negative_keywords",
    {
      description: [
        "Lista as palavras-chave negativas de TODAS as origens, com IDs para remover:",
        "- CAMPAIGN: negativas da campanha (Pesquisa, Shopping, Performance Max)",
        "- AD_GROUP: negativas do grupo de anúncios",
        "- SHARED_LIST: palavras das listas compartilhadas vinculadas às campanhas (listas do MCC aparecem como aviso)",
        "- ACCOUNT: a lista de negativas de nível de conta (vale para Pesquisa/Shopping de todas as campanhas)",
        "Com campaignId mostra o que se aplica àquela campanha; com adGroupId, o que se aplica ao grupo",
        "(grupo + campanha dele + listas da campanha + conta). source restringe a uma origem.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (inclui as negativas da campanha dele)."),
        source: z.enum(["ALL", "CAMPAIGN", "AD_GROUP", "SHARED_LIST", "ACCOUNT"]).optional().describe("Origem. Padrão: ALL."),
        limit: z.number().optional().describe("Máximo de linhas por origem. Padrão: 1000 (máx. 10000)."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, source, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      for (const [name, value] of [["campaignId", campaignId], ["adGroupId", adGroupId]] as const) {
        if (value !== undefined && !ID.test(value)) return fail(`${name} deve ser numérico, recebido "${value}".`);
      }
      const max = limit ?? 1000;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit}).`);
      const wanted = source ?? "ALL";
      const want = (s: string) => wanted === "ALL" || wanted === s;
      const client = ctx.getClient();
      const cid = cleanCid(customerId);

      let campaignFilter = campaignId;
      if (adGroupId) {
        const adGroup = await readAdGroup(client, customerId, adGroupId);
        if (!adGroup) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}.`);
        if (campaignId && adGroup.campaignId !== campaignId) {
          return fail(`O grupo ${adGroupId} é da campanha ${adGroup.campaignId}, não da ${campaignId}.`);
        }
        campaignFilter = adGroup.campaignId;
      }
      const byCampaign = campaignFilter ? ` AND campaign.id = ${campaignFilter}` : "";

      const rows: Row[] = [];
      const notes: string[] = [];
      const summary: Record<string, number> = {};
      const checkLimit = (count: number, what: string) => {
        if (count >= max) notes.push(`${what}: limite de ${max} linhas atingido — aumente limit para ver tudo.`);
      };
      const push = (sourceName: string, negative: ExistingNegative, extra: Row) => {
        rows.push({
          source: sourceName,
          text: negative.text,
          match_type: negative.matchType,
          criterion_id: negative.criterionId,
          ...extra,
          resource_name: negative.resourceName,
        });
        summary[sourceName] = (summary[sourceName] ?? 0) + 1;
      };

      if (want("CAMPAIGN")) {
        const result = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign_criterion.criterion_id, campaign_criterion.resource_name,
                  campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
           FROM campaign_criterion
           WHERE campaign_criterion.type = 'KEYWORD'
             AND campaign_criterion.negative = true
             AND campaign_criterion.status != 'REMOVED'
             AND campaign.status != 'REMOVED'${byCampaign}
           LIMIT ${max}`);
        for (const row of result) {
          const c = (row.campaign ?? {}) as Row;
          push("CAMPAIGN", toExisting(row.campaignCriterion as Row), {
            scope: `campanha ${c.id} (${c.name ?? ""})`, campaign_id: String(c.id ?? ""),
          });
        }
        checkLimit(result.length, "CAMPAIGN");
      }

      if (want("AD_GROUP")) {
        const byAdGroup = adGroupId ? ` AND ad_group.id = ${adGroupId}` : "";
        const result = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
                  ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
           FROM ad_group_criterion
           WHERE ad_group_criterion.type = 'KEYWORD'
             AND ad_group_criterion.negative = true
             AND ad_group_criterion.status != 'REMOVED'
             AND ad_group.status != 'REMOVED'
             AND campaign.status != 'REMOVED'${byCampaign}${byAdGroup}
           LIMIT ${max}`);
        for (const row of result) {
          const c = (row.campaign ?? {}) as Row;
          const g = (row.adGroup ?? {}) as Row;
          push("AD_GROUP", toExisting(row.adGroupCriterion as Row), {
            scope: `grupo ${g.id} (${g.name ?? ""}) / campanha ${c.id}`, campaign_id: String(c.id ?? ""), ad_group_id: String(g.id ?? ""),
          });
        }
        checkLimit(result.length, "AD_GROUP");
      }

      if (want("SHARED_LIST")) {
        const links = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign_shared_set.shared_set, campaign_shared_set.status
           FROM campaign_shared_set
           WHERE campaign_shared_set.status = 'ENABLED'
             AND campaign.status != 'REMOVED'${byCampaign}`);
        const sets = await client.searchStream(customerId,
          `SELECT shared_set.id, shared_set.name, shared_set.member_count, shared_set.resource_name
           FROM shared_set
           WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
             AND shared_set.status = 'ENABLED'`);
        const ownSets = new Map(sets.map((row) => [String(((row.sharedSet ?? {}) as Row).id ?? ""), toSharedSet(row)]));
        const campaignsBySet = new Map<string, string[]>();
        for (const row of links) {
          const c = (row.campaign ?? {}) as Row;
          const setResource = String(((row.campaignSharedSet ?? {}) as Row).sharedSet ?? "");
          campaignsBySet.set(setResource, [...(campaignsBySet.get(setResource) ?? []), `${c.id} (${c.name ?? ""})`]);
        }
        const included: string[] = [];
        for (const [setResource, campaigns] of campaignsBySet) {
          const owner = ownerOf(setResource);
          if (owner && owner !== cid) {
            notes.push(`Lista ${setResource} (da conta ${owner}, provavelmente o MCC) vinculada a ${campaigns.join(", ")}: ` +
              `as palavras só podem ser lidas na conta dona — get_shared_set_members com customerId=${owner}.`);
          } else if (ownSets.has(lastId(setResource))) {
            included.push(lastId(setResource));
          }
        }
        if (included.length) {
          const members = await client.searchStream(customerId,
            `SELECT shared_set.id, shared_set.name, shared_criterion.criterion_id, shared_criterion.resource_name,
                    shared_criterion.keyword.text, shared_criterion.keyword.match_type
             FROM shared_criterion
             WHERE shared_criterion.type = 'KEYWORD'
               AND shared_set.id IN (${included.join(", ")})
             LIMIT ${max}`);
          for (const row of members) {
            const s = (row.sharedSet ?? {}) as Row;
            const setResource = `customers/${cid}/sharedSets/${s.id}`;
            push("SHARED_LIST", toExisting(row.sharedCriterion as Row), {
              scope: `lista ${s.id} (${s.name ?? ""}) → campanhas ${(campaignsBySet.get(setResource) ?? []).join(", ")}`,
              shared_set_id: String(s.id ?? ""),
            });
          }
          checkLimit(members.length, "SHARED_LIST");
        }
        if (!campaignFilter) {
          const unattached = [...ownSets.values()].filter((s) => !campaignsBySet.has(`customers/${cid}/sharedSets/${s.id}`));
          if (unattached.length) {
            notes.push(`Listas sem campanha vinculada (não afetam nada): ${unattached.map((s) => `${s.name} (${s.id}, ${s.memberCount} palavras)`).join(", ")}.`);
          }
        }
      }

      if (want("ACCOUNT")) {
        for (const link of await readAccountListLinks(client, customerId)) {
          const owner = ownerOf(link.sharedSet);
          if (owner && owner !== cid) {
            notes.push(`A lista de negativas da conta é ${link.sharedSet}, da conta ${owner} (MCC): leia com get_shared_set_members customerId=${owner}.`);
            continue;
          }
          const setId = lastId(link.sharedSet);
          if (!ID.test(setId)) continue;
          const members = await client.searchStream(customerId,
            `SELECT shared_set.id, shared_set.name, shared_criterion.criterion_id, shared_criterion.resource_name,
                    shared_criterion.keyword.text, shared_criterion.keyword.match_type
             FROM shared_criterion
             WHERE shared_criterion.type = 'KEYWORD'
               AND shared_set.id = ${setId}
             LIMIT ${max}`);
          for (const row of members) {
            const s = (row.sharedSet ?? {}) as Row;
            push("ACCOUNT", toExisting(row.sharedCriterion as Row), {
              scope: `conta inteira (lista ${s.id} ${s.name ?? ""})`, shared_set_id: String(s.id ?? ""),
            });
          }
          checkLimit(members.length, "ACCOUNT");
        }
      }

      const noteBlock = notes.length ? [text(`Observações:\n- ${notes.join("\n- ")}`)] : [];
      if (format === "table") return { content: [text(formatAsTable(rows)), ...noteBlock] };
      if (format === "csv") return { content: [text(formatAsCsv(rows)), ...noteBlock] };
      return {
        content: [text(`${rows.length} negativa(s) — ${Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(", ") || "nenhuma"}.\n\n` +
          formatJson({ summary, notes, negatives: rows }))],
      };
    }
  );

  ctx.mcp.registerTool(
    "list_shared_sets",
    {
      description: [
        "Lista as listas compartilhadas de exclusão da conta: tipo, status, nº de palavras (member_count),",
        "nº de campanhas (reference_count), campanhas vinculadas e se está vinculada à conta inteira.",
        "Padrão: listas de palavras-chave negativas (NEGATIVE_KEYWORDS e ACCOUNT_LEVEL_NEGATIVE_KEYWORDS).",
        "Listas de um MCC vinculadas a campanhas desta conta aparecem em mcc_lists. Rode com o customerId do",
        "MCC para ver as listas que ele mesmo tem (e que podem ser vinculadas às contas-filhas).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta ou MCC)."),
        type: z.enum(["NEGATIVE_KEYWORDS", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS", "NEGATIVE_PLACEMENTS", "ALL_NEGATIVES"])
          .optional()
          .describe("Tipo. Padrão: as duas de palavras-chave. ALL_NEGATIVES inclui NEGATIVE_PLACEMENTS."),
        includeRemoved: z.boolean().optional().describe("Inclui listas removidas. Padrão: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, type, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const types = type === "ALL_NEGATIVES"
        ? ["NEGATIVE_KEYWORDS", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS", "NEGATIVE_PLACEMENTS"]
        : type ? [type] : ["NEGATIVE_KEYWORDS", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"];
      const client = ctx.getClient();
      const cid = cleanCid(customerId);

      const setRows = await client.searchStream(customerId,
        `SELECT ${SHARED_SET_FIELDS}
         FROM shared_set
         WHERE shared_set.type IN (${types.map((t) => `'${t}'`).join(", ")})${includeRemoved ? "" : " AND shared_set.status = 'ENABLED'"}
         ORDER BY shared_set.name`);
      const links = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign_shared_set.shared_set, campaign_shared_set.status
         FROM campaign_shared_set
         WHERE campaign_shared_set.status = 'ENABLED'`);
      const accountLinks = await client.searchStream(customerId,
        `SELECT customer_negative_criterion.id, customer_negative_criterion.type,
                customer_negative_criterion.negative_keyword_list.shared_set,
                customer_negative_criterion.placement_list.shared_set
         FROM customer_negative_criterion
         WHERE customer_negative_criterion.type IN ('NEGATIVE_KEYWORD_LIST', 'PLACEMENT_LIST')`);

      const campaignsBySet = new Map<string, string[]>();
      for (const row of links) {
        const c = (row.campaign ?? {}) as Row;
        const setResource = String(((row.campaignSharedSet ?? {}) as Row).sharedSet ?? "");
        const label = `${c.id} (${c.name ?? ""}${c.status && c.status !== "ENABLED" ? `, ${c.status}` : ""})`;
        campaignsBySet.set(setResource, [...(campaignsBySet.get(setResource) ?? []), label]);
      }
      const accountSets = new Set(accountLinks.map((row) => {
        const c = (row.customerNegativeCriterion ?? {}) as Row;
        return String(((c.negativeKeywordList ?? {}) as Row).sharedSet ?? ((c.placementList ?? {}) as Row).sharedSet ?? "");
      }).filter(Boolean));

      const rows = setRows.map((row) => {
        const s = toSharedSet(row);
        const resource = s.resourceName || `customers/${cid}/sharedSets/${s.id}`;
        const capacity = s.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" ? NEGATIVE_LIMITS.accountLevel
          : s.type === "NEGATIVE_KEYWORDS" ? NEGATIVE_LIMITS.perSharedList : undefined;
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          member_count: s.memberCount,
          ...(capacity ? { capacity } : {}),
          reference_count: s.referenceCount,
          campaigns: (campaignsBySet.get(resource) ?? []).join("; "),
          attached_to_account: accountSets.has(resource),
          resource_name: resource,
        };
      });
      const own = new Set(rows.map((r) => r.resource_name));
      const foreign = new Set([...campaignsBySet.keys(), ...accountSets].filter((r) => ownerOf(r) && ownerOf(r) !== cid && !own.has(r)));
      const mccLists = [...foreign].map((resource) => ({
        resource_name: resource,
        owner_customer_id: ownerOf(resource),
        campaigns: (campaignsBySet.get(resource) ?? []).join("; "),
        attached_to_account: accountSets.has(resource),
      }));

      if (format === "table") return { content: [text(formatAsTable(rows))] };
      if (format === "csv") return { content: [text(formatAsCsv(rows))] };
      const keywordLists = rows.filter((r) => r.type === "NEGATIVE_KEYWORDS" && r.status === "ENABLED").length;
      const notes: string[] = [];
      if (keywordLists >= NEGATIVE_LIMITS.listsPerAccount) {
        notes.push(`A conta está no limite de ${NEGATIVE_LIMITS.listsPerAccount} listas de negativas.`);
      }
      if (mccLists.length) notes.push("mcc_lists: listas de outra conta (MCC) — edite-as com o customerId dessa conta.");
      return {
        content: [text(`${rows.length} lista(s) compartilhada(s)${mccLists.length ? ` + ${mccLists.length} do MCC` : ""}.\n\n` +
          formatJson({ shared_sets: rows, mcc_lists: mccLists, notes }))],
      };
    }
  );

  ctx.mcp.registerTool(
    "get_shared_set_members",
    {
      description: [
        "Mostra o conteúdo de uma lista compartilhada: cada item com criterion_id (para remover), tipo,",
        "texto/URL e correspondência, mais as campanhas vinculadas e se a lista vale para a conta inteira.",
        "sharedSetId: o ID (list_shared_sets). Lista do MCC: use o customerId do MCC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID da conta dona da lista."),
        sharedSetId: z.string().describe("ID da lista (ou resource name customers/{customerId}/sharedSets/{id})."),
        contains: z.string().optional().describe("Filtra itens cujo texto contém este trecho (sem diferenciar maiúsculas)."),
        limit: z.number().optional().describe("Máximo de itens. Padrão: 5000."),
        format: formatSchema,
      },
    },
    async ({ customerId, sharedSetId, contains, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const ref = parseSharedSetRef(sharedSetId, cid);
      if ("error" in ref) return fail(ref.error);
      if (ref.owner !== cid) {
        return fail(`A lista ${ref.resourceName} é da conta ${ref.owner}: rode com customerId=${ref.owner} (os itens só podem ser lidos na conta dona).`);
      }
      const max = limit ?? NEGATIVE_LIMITS.perSharedList;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit}).`);
      const client = ctx.getClient();
      const set = await readSharedSet(client, customerId, ref.id);
      if (!set) return fail(`Lista ${ref.id} não encontrada na conta ${cid} (veja list_shared_sets).`);

      const memberRows = await client.searchStream(customerId,
        `SELECT shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text,
                shared_criterion.keyword.match_type, shared_criterion.placement.url,
                shared_criterion.youtube_channel.channel_id, shared_criterion.youtube_video.video_id,
                shared_criterion.mobile_application.app_id, shared_criterion.mobile_application.name,
                shared_criterion.resource_name
         FROM shared_criterion
         WHERE shared_set.id = ${ref.id}
         LIMIT ${max}`);
      const needle = contains ? cleanText(contains).toLowerCase() : "";
      const members = memberRows.map((row) => {
        const c = (row.sharedCriterion ?? {}) as Row;
        const keyword = (c.keyword ?? {}) as Row;
        const app = (c.mobileApplication ?? {}) as Row;
        const value = keyword.text ?? ((c.placement ?? {}) as Row).url ?? ((c.youtubeChannel ?? {}) as Row).channelId ??
          ((c.youtubeVideo ?? {}) as Row).videoId ?? (app.appId ? `${app.appId}${app.name ? ` (${app.name})` : ""}` : "");
        return {
          criterion_id: String(c.criterionId ?? ""),
          type: String(c.type ?? ""),
          value: String(value ?? ""),
          match_type: String(keyword.matchType ?? ""),
          resource_name: String(c.resourceName ?? ""),
        };
      }).filter((m) => !needle || m.value.toLowerCase().includes(needle));

      const campaigns = await readCampaignLinks(client, customerId, ref.resourceName);
      const attachedToAccount = set.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"
        ? (await readAccountListLinks(client, customerId)).some((l) => l.sharedSet === ref.resourceName)
        : undefined;

      if (format === "table") return { content: [text(formatAsTable(members))] };
      if (format === "csv") return { content: [text(formatAsCsv(members))] };
      return {
        content: [text(`Lista "${set.name}" (${set.type}, ${set.status}): ${members.length} item(ns) mostrados de ${set.memberCount}.\n\n` +
          formatJson({
            shared_set: {
              id: set.id, name: set.name, type: set.type, status: set.status, member_count: set.memberCount,
              reference_count: set.referenceCount, resource_name: ref.resourceName,
            },
            campaigns: campaigns.map((c) => `${c.campaignId} (${c.campaignName})`),
            ...(attachedToAccount !== undefined ? { attached_to_account: attachedToAccount } : {}),
            truncated: memberRows.length >= max,
            members,
          }))],
      };
    }
  );

  // ── Escrita: campanha e grupo de anúncios ──────────────────────────

  ctx.mcp.registerTool(
    "add_negative_keyword",
    {
      description: [
        "Adiciona palavras-chave negativas a uma campanha ou a um grupo de anúncios — uma ou várias por chamada.",
        "WRITE OPERATION — reversível com remove_negative_keyword.",
        "",
        "- level CAMPAIGN (padrão): campaignId. Vale para Pesquisa, Shopping e Performance Max (até 10.000 por campanha).",
        "- level AD_GROUP: adGroupId (campaignId opcional, só para conferir). PMax não tem grupos de anúncios.",
        "- keywords [{text, matchType}] para lote; keyword + matchType continua aceito para uma só.",
        "Negativas que já existem no mesmo nível (mesmo texto e correspondência) são puladas; cada item tem o",
        "próprio resultado (partialFailure). Texto até 80 caracteres e 10 palavras, sem [ ], aspas ou '-'.",
        "Listas compartilhadas: update_shared_set_members. Conta inteira: add_account_negative_keywords.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["CAMPAIGN", "AD_GROUP"]).optional().describe("Nível. Padrão: AD_GROUP se adGroupId vier, senão CAMPAIGN."),
        campaignId: z.string().optional().describe("ID da campanha (obrigatório em CAMPAIGN)."),
        adGroupId: z.string().optional().describe("ID do grupo de anúncios (obrigatório em AD_GROUP)."),
        keywords: flexArray(keywordSchema).optional().describe("Lote [{text, matchType}]."),
        keyword: z.string().optional().describe("Uma negativa só (forma antiga)."),
        matchType: matchTypeSchema.optional().describe("Correspondência de keyword."),
      },
    },
    async ({ customerId, level: rawLevel, campaignId, adGroupId, keywords, keyword, matchType }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi adicionado.`);
      const level = rawLevel ?? (adGroupId !== undefined ? "AD_GROUP" : "CAMPAIGN");
      if (level === "CAMPAIGN" && adGroupId !== undefined) {
        return refuse("adGroupId veio com level CAMPAIGN — use level AD_GROUP para negativar no grupo.");
      }
      if (level === "CAMPAIGN" && !campaignId) return refuse("level CAMPAIGN exige campaignId.");
      if (level === "AD_GROUP" && !adGroupId) return refuse("level AD_GROUP exige adGroupId.");
      for (const [name, value] of [["campaignId", campaignId], ["adGroupId", adGroupId]] as const) {
        if (value !== undefined && !ID.test(value)) return refuse(`${name} deve ser numérico, recebido "${value}".`);
      }
      if (keyword !== undefined && !matchType) return refuse("keyword exige matchType (EXACT, PHRASE ou BROAD).");
      const rawItems = [...ensureArray<unknown>(keywords), ...(keyword !== undefined ? [{ text: keyword, matchType }] : [])];
      if (rawItems.length === 0) return refuse("Informe keywords [{text, matchType}] ou keyword + matchType.");
      const parsed = parseKeywords(rawItems);
      if (parsed.invalid.length) return refuse(`Negativas inválidas:\n- ${parsed.invalid.join("\n- ")}\n`);
      if (parsed.keywords.length > NEGATIVE_LIMITS.operationsPerRequest) {
        return refuse(`${parsed.keywords.length} negativas numa chamada — o máximo é ${NEGATIVE_LIMITS.operationsPerRequest}.`);
      }

      const client = ctx.getClient();
      const cid = cleanCid(customerId);
      let existing: ExistingNegative[];
      let target: Row;
      let channel: string;
      if (level === "CAMPAIGN") {
        const campaign = (await readCampaigns(client, customerId, [campaignId!])).get(campaignId!);
        if (!campaign) return refuse(`Campanha ${campaignId} não encontrada na conta ${cid}.`);
        if (campaign.status === "REMOVED") return refuse(`A campanha ${campaignId} está removida.`);
        channel = campaign.channel;
        target = { level, campaign_id: campaign.id, campaign_name: campaign.name, channel };
        existing = await readCampaignNegatives(client, customerId, campaign.id);
      } else {
        const adGroup = await readAdGroup(client, customerId, adGroupId!);
        if (!adGroup) {
          return refuse(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid} (Performance Max não tem grupos — use level CAMPAIGN).`);
        }
        if (campaignId && adGroup.campaignId !== campaignId) {
          return refuse(`O grupo ${adGroupId} é da campanha ${adGroup.campaignId}, não da ${campaignId}.`);
        }
        if (adGroup.status === "REMOVED") return refuse(`O grupo ${adGroupId} está removido.`);
        channel = adGroup.channel;
        target = { level, ad_group_id: adGroup.id, ad_group_name: adGroup.name, campaign_id: adGroup.campaignId, channel };
        existing = await readAdGroupNegatives(client, customerId, adGroup.id);
      }

      const existingKeys = new Set(existing.map(keywordKey));
      const alreadyPresent = parsed.keywords.filter((k) => existingKeys.has(keywordKey(k))).map(describeKeyword);
      const toAdd = parsed.keywords.filter((k) => !existingKeys.has(keywordKey(k)));
      const warnings: string[] = [];
      if (level === "CAMPAIGN") {
        const total = existing.length + toAdd.length;
        if (total > NEGATIVE_LIMITS.perCampaign) {
          return refuse(`A campanha ficaria com ${total} negativas (já tem ${existing.length}); o limite é ` +
            `${NEGATIVE_LIMITS.perCampaign} por campanha. Mova parte para uma lista compartilhada (create_shared_negative_list).`);
        }
        if (DISPLAY_VIDEO_CHANNELS.has(channel) && total > NEGATIVE_LIMITS.displayVideoConsidered) {
          warnings.push(`Campanhas de ${channel} só consideram ${NEGATIVE_LIMITS.displayVideoConsidered} negativas; esta ficaria com ${total}.`);
        }
      }
      const where = level === "CAMPAIGN" ? `campanha ${campaignId}` : `grupo ${adGroupId}`;
      if (toAdd.length === 0) {
        return {
          content: [text(`Nada a adicionar em ${where}: as negativas pedidas já existem. Nenhuma escrita foi enviada.\n\n` +
            formatJson({ target, already_present: alreadyPresent, duplicates_in_input: parsed.duplicates }))],
        };
      }

      const parent = level === "CAMPAIGN"
        ? { campaign: `customers/${cid}/campaigns/${campaignId}` }
        : { adGroup: `customers/${cid}/adGroups/${adGroupId}` };
      const operations = toAdd.map((k) => ({
        create: { ...parent, negative: true, keyword: { text: k.text, matchType: k.matchType } },
      }));
      let response: Row;
      try {
        response = await client.mutate(customerId, level === "CAMPAIGN" ? "campaignCriteria" : "adGroupCriteria", operations, { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi adicionado — a API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, toAdd, dryRun);
      const errors: Row[] = [
        ...report.failed.map((f) => ({ keyword: describeKeyword(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `${where} — DRY-RUN (validateOnly): ${report.ok.length} negativa(s) validada(s), nada foi gravado.`
            : `${where}: ${report.ok.length} negativa(s) adicionada(s).`) +
          ` Já existiam: ${alreadyPresent.length} | Duplicadas na entrada: ${parsed.duplicates.length} | Com erro: ${errors.length}\n\n` +
          formatJson({
            target,
            [dryRun ? "validated" : "added"]: report.ok.map(describeKeyword),
            already_present: alreadyPresent,
            duplicates_in_input: parsed.duplicates,
            errors,
            warnings,
          })
        )],
        isError: errors.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "remove_negative_keyword",
    {
      description: [
        "Remove palavras-chave negativas de uma campanha ou de um grupo de anúncios.",
        "WRITE OPERATION — reversível: é só adicionar de novo com add_negative_keyword.",
        "",
        "- level CAMPAIGN (padrão): campaignId. level AD_GROUP: adGroupId.",
        "Identifique por criterionIds (ver list_negative_keywords) ou por keywords [{text, matchType}].",
        `Mais de ${NEGATIVE_LIMITS.bulkRemoveWithoutConfirm} de uma vez exige confirm: true (sem ele, devolve a prévia).`,
        "Listas compartilhadas: update_shared_set_members. Conta inteira: remove_account_negative_keywords.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["CAMPAIGN", "AD_GROUP"]).optional().describe("Nível. Padrão: AD_GROUP se adGroupId vier, senão CAMPAIGN."),
        campaignId: z.string().optional().describe("Campaign ID (obrigatório em CAMPAIGN)."),
        adGroupId: z.string().optional().describe("ID do grupo (obrigatório em AD_GROUP)."),
        criterionIds: flexArray(z.string()).optional().describe("IDs das negativas (criterion_id)."),
        keywords: flexArray(keywordSchema).optional().describe("Negativas por texto + correspondência."),
        confirm: z.boolean().optional().describe(`Obrigatório acima de ${NEGATIVE_LIMITS.bulkRemoveWithoutConfirm} negativas.`),
      },
    },
    async ({ customerId, level: rawLevel, campaignId, adGroupId, criterionIds, keywords, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const level = rawLevel ?? (adGroupId !== undefined ? "AD_GROUP" : "CAMPAIGN");
      if (level === "CAMPAIGN") {
        if (adGroupId !== undefined) return fail("adGroupId veio com level CAMPAIGN — use level AD_GROUP. Nada foi removido.");
        if (!campaignId || !ID.test(campaignId)) {
          return fail(`campaignId deve ser numérico, recebido "${campaignId ?? ""}". Nada foi removido.`);
        }
      } else {
        if (!adGroupId || !ID.test(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId ?? ""}". Nada foi removido.`);
        if (campaignId !== undefined && !ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi removido.`);
      }
      const { ids, bad } = parseIds(criterionIds);
      if (bad.length > 0) return fail(`criterionIds devem ser numéricos: ${bad.join(", ")}. Nada foi removido.`);
      const wanted = parseKeywords(ensureArray<unknown>(keywords));
      if (wanted.invalid.length) return fail(`keywords inválidas:\n- ${wanted.invalid.join("\n- ")}\nNada foi removido.`);
      if (ids.length === 0 && wanted.keywords.length === 0) return fail("Informe criterionIds ou keywords. Nada foi removido.");

      const client = ctx.getClient();
      const negatives = level === "CAMPAIGN"
        ? await readCampaignNegatives(client, customerId, campaignId!)
        : await readAdGroupNegatives(client, customerId, adGroupId!);
      const where = level === "CAMPAIGN" ? `Campanha ${campaignId}` : `Grupo ${adGroupId}`;
      if (level === "AD_GROUP" && campaignId) {
        const adGroup = await readAdGroup(client, customerId, adGroupId!);
        if (adGroup && adGroup.campaignId !== campaignId) {
          return fail(`O grupo ${adGroupId} é da campanha ${adGroup.campaignId}, não da ${campaignId}. Nada foi removido.`);
        }
      }
      const targets = new Map<string, ExistingNegative>();
      const notFound: string[] = [];
      for (const id of ids) {
        const found = negatives.find((negative) => negative.criterionId === id);
        if (found) targets.set(found.resourceName, found);
        else notFound.push(`criterionId ${id}`);
      }
      for (const k of wanted.keywords) {
        const found = negatives.find((negative) => keywordKey(negative) === keywordKey(k));
        if (found) targets.set(found.resourceName, found);
        else notFound.push(describeKeyword(k));
      }
      const toRemove = [...targets.values()];
      if (toRemove.length === 0) {
        return fail(`Nenhuma das negativas pedidas existe ${level === "CAMPAIGN" ? `na campanha ${campaignId}` : `no grupo ${adGroupId}`}. ` +
          `Nada foi removido.\nNão encontradas: ${notFound.join(", ")}`);
      }
      const describe = (negative: ExistingNegative) => ({ criterion_id: negative.criterionId, keyword: describeKeyword(negative) });
      if (toRemove.length > NEGATIVE_LIMITS.bulkRemoveWithoutConfirm && confirm !== true && !client.isDryRun) {
        return preview(`${where}: ${toRemove.length} negativas seriam removidas (acima de ${NEGATIVE_LIMITS.bulkRemoveWithoutConfirm} exige confirm).`,
          { to_remove: toRemove.map(describe), not_found: notFound });
      }

      let response: Row;
      try {
        response = await client.mutate(customerId, level === "CAMPAIGN" ? "campaignCriteria" : "adGroupCriteria",
          toRemove.map((negative) => ({ remove: negative.resourceName })), { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi removido — a API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, toRemove, dryRun);
      const errors: Row[] = [
        ...report.failed.map((f) => ({ ...describe(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `${where} — DRY-RUN (validateOnly): nada foi removido. Validadas: ${report.ok.length}`
            : `${where}: ${report.ok.length} negativa(s) removida(s)`) +
          ` | Não encontradas: ${notFound.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "removed"]: report.ok.map(describe), not_found: notFound, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );

  // ── Escrita: listas compartilhadas ─────────────────────────────────

  ctx.mcp.registerTool(
    "create_shared_negative_list",
    {
      description: [
        "Cria uma lista compartilhada de palavras-chave negativas (NEGATIVE_KEYWORDS) e, se quiser, vincula a campanhas.",
        "WRITE OPERATION — lista, palavras e vínculos vão numa única operação atômica (googleAds:mutate):",
        "ou tudo é criado, ou nada.",
        `Limites: ${NEGATIVE_LIMITS.perSharedList} palavras por lista e ${NEGATIVE_LIMITS.listsPerAccount} listas por conta; nome único entre as listas ativas.`,
        "Para editar depois: update_shared_set_members; vincular/desvincular: attach_shared_set / detach_shared_set.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da lista (1 a 255 bytes)."),
        keywords: flexArray(keywordSchema).describe("Palavras [{text, matchType}] (pode ser vazia)."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas para vincular a lista."),
      },
    },
    async ({ customerId, name, keywords, campaignIds }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi criado.`);
      const listName = cleanText(name ?? "");
      const bytes = Buffer.byteLength(listName, "utf8");
      if (bytes < 1 || bytes > 255) return refuse(`O nome da lista deve ter de 1 a 255 bytes (recebido ${bytes}).`);
      const parsed = parseKeywords(ensureArray<unknown>(keywords));
      if (parsed.invalid.length) return refuse(`Palavras inválidas:\n- ${parsed.invalid.join("\n- ")}\n`);
      if (parsed.keywords.length > NEGATIVE_LIMITS.perSharedList) {
        return refuse(`${parsed.keywords.length} palavras — uma lista aceita até ${NEGATIVE_LIMITS.perSharedList}.`);
      }
      const { ids, bad } = parseIds(campaignIds);
      if (bad.length) return refuse(`campaignIds devem ser numéricos: ${bad.join(", ")}.`);
      if (1 + parsed.keywords.length + ids.length > NEGATIVE_LIMITS.operationsPerRequest) {
        return refuse(`A operação passaria de ${NEGATIVE_LIMITS.operationsPerRequest} itens por requisição.`);
      }

      const client = ctx.getClient();
      const cid = cleanCid(customerId);
      const lists = (await client.searchStream(customerId,
        `SELECT shared_set.id, shared_set.name, shared_set.status
         FROM shared_set
         WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
           AND shared_set.status = 'ENABLED'`)).map(toSharedSet);
      const sameName = lists.find((s) => s.name === listName);
      if (sameName) {
        return refuse(`Já existe a lista ativa "${listName}" (ID ${sameName.id}). Edite-a com update_shared_set_members ` +
          "ou vincule-a com attach_shared_set.");
      }
      if (lists.length >= NEGATIVE_LIMITS.listsPerAccount) {
        return refuse(`A conta já tem ${lists.length} listas de negativas ativas (limite ${NEGATIVE_LIMITS.listsPerAccount}).`);
      }
      const campaigns = await readCampaigns(client, customerId, ids);
      const missing = ids.filter((id) => !campaigns.has(id));
      const removed = ids.filter((id) => campaigns.get(id)?.status === "REMOVED");
      if (missing.length || removed.length) {
        return refuse([
          missing.length ? `Campanhas não encontradas na conta ${cid}: ${missing.join(", ")}.` : "",
          removed.length ? `Campanhas removidas: ${removed.join(", ")}.` : "",
        ].filter(Boolean).join(" "));
      }

      const setTemp = `customers/${cid}/sharedSets/-1`;
      const operations: Row[] = [
        { sharedSetOperation: { create: { resourceName: setTemp, name: listName, type: "NEGATIVE_KEYWORDS" } } },
        ...parsed.keywords.map((k) => ({
          sharedCriterionOperation: { create: { sharedSet: setTemp, keyword: { text: k.text, matchType: k.matchType } } },
        })),
        ...ids.map((id) => ({
          campaignSharedSetOperation: { create: { campaign: `customers/${cid}/campaigns/${id}`, sharedSet: setTemp } },
        })),
      ];
      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return refuse(`A API recusou (operação atômica: lista, palavras e vínculos).\nErro: ${withHint((err as Error).message)}\n`);
      }
      const dryRun = client.isDryRun;
      const responses = (response.mutateOperationResponses as Row[]) ?? [];
      const setResource = ((responses.find((r) => r.sharedSetResult)?.sharedSetResult ?? {}) as Row).resourceName as string | undefined;
      if (!dryRun && !setResource) {
        return fail(`A API não confirmou a criação da lista — confira em list_shared_sets antes de repetir.\n\n${formatJson(response)}`);
      }
      const attached = ids.map((id) => `${id} (${campaigns.get(id)?.name ?? ""})`);
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): lista "${listName}" validada pela API — nada foi criado.\n`
            : `Lista "${listName}" criada: ${setResource}\n`) +
          `- Palavras: ${parsed.keywords.length}${parsed.duplicates.length ? ` (${parsed.duplicates.length} duplicada(s) na entrada ignorada(s))` : ""}\n` +
          `- Campanhas vinculadas: ${attached.length ? attached.join(", ") : "nenhuma (use attach_shared_set)"}\n`
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "update_shared_set_members",
    {
      description: [
        "Adiciona e/ou remove palavras de uma lista compartilhada de negativas (NEGATIVE_KEYWORDS ou a lista de",
        "nível de conta), numa só chamada com resultado por item (partialFailure).",
        "WRITE OPERATION — a mudança vale para TODAS as campanhas vinculadas à lista.",
        "",
        "- add [{text, matchType}]: palavras já presentes são puladas.",
        "- remove [{text, matchType}] e/ou removeCriterionIds (get_shared_set_members).",
        "confirm: true é exigido quando algo é removido, quando a lista é a de nível de conta ou quando a conta é",
        "um MCC (a lista pode valer para várias contas). Sem confirm, devolve a prévia.",
        `Limite: ${NEGATIVE_LIMITS.perSharedList} palavras por lista (${NEGATIVE_LIMITS.accountLevel} na de nível de conta).`,
        "Lista do MCC: rode com o customerId do MCC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID da conta dona da lista."),
        sharedSetId: z.string().describe("ID da lista (ou resource name customers/{customerId}/sharedSets/{id})."),
        add: flexArray(keywordSchema).optional().describe("Palavras a adicionar."),
        remove: flexArray(keywordSchema).optional().describe("Palavras a remover (texto + correspondência)."),
        removeCriterionIds: flexArray(z.string()).optional().describe("criterion_id das palavras a remover."),
        confirm: z.boolean().optional().describe("Necessário para remover, para a lista de nível de conta e em MCC."),
      },
    },
    async ({ customerId, sharedSetId, add, remove, removeCriterionIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi alterado.`);
      const cid = cleanCid(customerId);
      const ref = parseSharedSetRef(sharedSetId, cid);
      if ("error" in ref) return refuse(ref.error);
      if (ref.owner !== cid) {
        return refuse(`A lista ${ref.resourceName} é da conta ${ref.owner}: edite com customerId=${ref.owner}.`);
      }
      const toAddInput = parseKeywords(ensureArray<unknown>(add));
      const toRemoveInput = parseKeywords(ensureArray<unknown>(remove));
      const invalid = [...toAddInput.invalid.map((m) => `add ${m}`), ...toRemoveInput.invalid.map((m) => `remove ${m}`)];
      if (invalid.length) return refuse(`Entradas inválidas:\n- ${invalid.join("\n- ")}\n`);
      const { ids, bad } = parseIds(removeCriterionIds);
      if (bad.length) return refuse(`removeCriterionIds devem ser numéricos: ${bad.join(", ")}.`);
      if (!toAddInput.keywords.length && !toRemoveInput.keywords.length && !ids.length) {
        return refuse("Informe add, remove ou removeCriterionIds.");
      }
      const removeKeys = new Set(toRemoveInput.keywords.map(keywordKey));
      const conflicting = toAddInput.keywords.filter((k) => removeKeys.has(keywordKey(k)));
      if (conflicting.length) return refuse(`As mesmas palavras estão em add e remove: ${conflicting.map(describeKeyword).join(", ")}.`);

      const client = ctx.getClient();
      const set = await readSharedSet(client, customerId, ref.id);
      if (!set) return refuse(`Lista ${ref.id} não encontrada na conta ${cid} (veja list_shared_sets).`);
      if (set.status !== "ENABLED") return refuse(`A lista ${ref.id} está ${set.status} e não aceita mudanças.`);
      if (!KEYWORD_SET_TYPES.has(set.type)) {
        return refuse(`A lista ${ref.id} é do tipo ${set.type}; esta tool edita só listas de palavras-chave negativas.`);
      }
      const members = await readSharedSetKeywords(client, customerId, ref.id);
      const memberKeys = new Map(members.map((m) => [keywordKey(m), m]));

      const alreadyPresent = toAddInput.keywords.filter((k) => memberKeys.has(keywordKey(k))).map(describeKeyword);
      const creates = toAddInput.keywords.filter((k) => !memberKeys.has(keywordKey(k)));
      const removals = new Map<string, ExistingNegative>();
      const notFound: string[] = [];
      for (const id of ids) {
        const found = members.find((m) => m.criterionId === id);
        if (found) removals.set(found.resourceName, found);
        else notFound.push(`criterionId ${id}`);
      }
      for (const k of toRemoveInput.keywords) {
        const found = memberKeys.get(keywordKey(k));
        if (found) removals.set(found.resourceName, found);
        else notFound.push(describeKeyword(k));
      }
      const removes = [...removals.values()];
      const capacity = set.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" ? NEGATIVE_LIMITS.accountLevel : NEGATIVE_LIMITS.perSharedList;
      const finalCount = members.length - removes.length + creates.length;
      if (creates.length && finalCount > capacity) {
        return refuse(`A lista ficaria com ${finalCount} palavras; o limite é ${capacity} (tem ${members.length}).`);
      }
      const summaryPayload = {
        shared_set: { id: set.id, name: set.name, type: set.type, member_count: members.length, reference_count: set.referenceCount },
        to_add: creates.map(describeKeyword),
        to_remove: removes.map((m) => ({ criterion_id: m.criterionId, keyword: describeKeyword(m) })),
        already_present: alreadyPresent,
        not_found: notFound,
      };
      if (!creates.length && !removes.length) {
        return {
          content: [text(`Lista "${set.name}": nada a mudar — as palavras pedidas já estão como pedido. Nenhuma escrita foi enviada.\n\n${formatJson(summaryPayload)}`)],
          isError: notFound.length > 0 && alreadyPresent.length === 0,
        };
      }
      let isManager = false;
      if (!removes.length && set.type === "NEGATIVE_KEYWORDS") {
        const customer = await client.searchStream(customerId, "SELECT customer.id, customer.manager FROM customer LIMIT 1");
        isManager = ((customer[0]?.customer ?? {}) as Row).manager === true;
      }
      const needsConfirm = removes.length > 0 || set.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" || isManager;
      if (needsConfirm && confirm !== true && !client.isDryRun) {
        const why = removes.length ? "remove palavras (mais tráfego em todas as campanhas da lista)"
          : set.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" ? "é a lista de nível de conta (vale para a conta inteira)"
            : "a conta é um MCC (a lista pode valer para várias contas)";
        return preview(`Lista "${set.name}": ${creates.length} a adicionar, ${removes.length} a remover — exige confirm porque ${why}.`, summaryPayload);
      }

      type Op = { kind: "add"; keyword: NegativeKeyword } | { kind: "remove"; member: ExistingNegative };
      // Remoções primeiro: liberam espaço antes das inclusões.
      const ops: Op[] = [
        ...removes.map((member) => ({ kind: "remove" as const, member })),
        ...creates.map((keyword) => ({ kind: "add" as const, keyword })),
      ];
      const operations = ops.map((op) => op.kind === "remove"
        ? { remove: op.member.resourceName }
        : { create: { sharedSet: ref.resourceName, keyword: { text: op.keyword.text, matchType: op.keyword.matchType } } });
      let response: Row;
      try {
        response = await client.mutate(customerId, "sharedCriteria", operations, { partialFailure: true });
      } catch (err) {
        return refuse(`A API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}\n`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, ops, dryRun);
      const label = (op: Op) => (op.kind === "add" ? describeKeyword(op.keyword) : describeKeyword(op.member));
      const errors: Row[] = [
        ...report.failed.map((f) => ({ action: f.item.kind, keyword: label(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      const added = report.ok.filter((op) => op.kind === "add").map(label);
      const removedOk = report.ok.filter((op) => op.kind === "remove").map(label);
      return {
        content: [text(
          (dryRun ? `Lista "${set.name}" — DRY-RUN (validateOnly): nada foi gravado. Validadas: ${added.length} inclusão(ões), ${removedOk.length} remoção(ões)`
            : `Lista "${set.name}": ${added.length} adicionada(s), ${removedOk.length} removida(s)`) +
          ` | Já presentes: ${alreadyPresent.length} | Não encontradas: ${notFound.length} | Com erro: ${errors.length}` +
          ` | Campanhas afetadas: ${set.referenceCount}\n\n` +
          formatJson({
            shared_set: summaryPayload.shared_set,
            [dryRun ? "validated_add" : "added"]: added,
            [dryRun ? "validated_remove" : "removed"]: removedOk,
            already_present: alreadyPresent,
            not_found: notFound,
            errors,
          })
        )],
        isError: errors.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "attach_shared_set",
    {
      description: [
        "Vincula uma lista compartilhada de exclusão a campanhas ou à conta inteira.",
        "WRITE OPERATION — reversível com detach_shared_set.",
        "",
        "- campaignIds: listas NEGATIVE_KEYWORDS (inclusive em Performance Max) ou NEGATIVE_PLACEMENTS (CampaignSharedSet).",
        "  Campanhas que já têm a lista são puladas; resultado por campanha (partialFailure).",
        "- toAccount: true: lista ACCOUNT_LEVEL_NEGATIVE_KEYWORDS vira a lista de negativas da conta",
        "  (CustomerNegativeCriterion; só uma por conta). Exige confirm: true.",
        "Lista do MCC: sharedSetId = customers/{mccId}/sharedSets/{id}. O MCC precisa estar na allowlist e ser",
        "gestor desta conta — senão o vínculo existiria sem efeito, e a tool recusa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID da conta onde vincular."),
        sharedSetId: z.string().describe("ID da lista desta conta ou resource name customers/{mccId}/sharedSets/{id}."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas a vincular."),
        toAccount: z.boolean().optional().describe("true = vincular à conta inteira (lista de nível de conta)."),
        confirm: z.boolean().optional().describe("Obrigatório com toAccount."),
      },
    },
    async ({ customerId, sharedSetId, campaignIds, toAccount, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi vinculado.`);
      const cid = cleanCid(customerId);
      const ref = parseSharedSetRef(sharedSetId, cid);
      if ("error" in ref) return refuse(ref.error);
      const { ids, bad } = parseIds(campaignIds);
      if (bad.length) return refuse(`campaignIds devem ser numéricos: ${bad.join(", ")}.`);
      if (toAccount === true && ids.length) return refuse("Use campaignIds OU toAccount, não os dois.");
      if (toAccount !== true && !ids.length) return refuse("Informe campaignIds ou toAccount: true.");
      if (ids.length > NEGATIVE_LIMITS.operationsPerRequest) return refuse(`Máximo de ${NEGATIVE_LIMITS.operationsPerRequest} campanhas por chamada.`);
      if (ref.owner !== cid) {
        const ownerBlocked = checkCustomerAccess(ref.owner, ctx.allowedCustomerIds, ctx.hosted);
        if (ownerBlocked) return refuse(`A lista é da conta ${ref.owner}, fora da allowlist deste servidor.`);
      }

      const client = ctx.getClient();
      const set = await readSharedSet(client, ref.owner, ref.id);
      if (!set) return refuse(`Lista ${ref.id} não encontrada na conta ${ref.owner}.`);
      if (set.status !== "ENABLED") return refuse(`A lista ${ref.id} está ${set.status} — lista removida não pode ser vinculada.`);
      if (ref.owner !== cid) {
        const hierarchy = await client.searchStream(ref.owner,
          `SELECT customer_client.id, customer_client.manager, customer_client.level
           FROM customer_client
           WHERE customer_client.id = ${cid}`);
        if (!hierarchy.length) {
          return refuse(`A conta ${cid} não está sob a conta ${ref.owner}: o vínculo existiria mas não teria efeito.`);
        }
      }

      if (toAccount === true) {
        if (set.type !== "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS") {
          return refuse(`toAccount aceita só listas ACCOUNT_LEVEL_NEGATIVE_KEYWORDS (esta é ${set.type}).`);
        }
        const links = await readAccountListLinks(client, customerId);
        if (links.some((l) => l.sharedSet === ref.resourceName)) {
          return { content: [text(`A lista ${ref.resourceName} já é a lista de negativas da conta ${cid}. Nenhuma escrita foi enviada.`)] };
        }
        if (links.length) {
          return refuse(`A conta ${cid} já tem a lista ${links[0].sharedSet} como negativas de nível de conta (só uma por conta). ` +
            "Desvincule-a antes com detach_shared_set (fromAccount: true).");
        }
        if (confirm !== true && !client.isDryRun) {
          return preview(`A lista "${set.name}" (${set.memberCount} palavras) passaria a valer para a conta ${cid} inteira.`,
            { shared_set: ref.resourceName, customer_id: cid });
        }
        let response: Row;
        try {
          response = await client.mutate(customerId, "customerNegativeCriteria", [{ create: { negativeKeywordList: { sharedSet: ref.resourceName } } }]);
        } catch (err) {
          return refuse(`A API recusou.\nErro: ${withHint((err as Error).message)}\n`);
        }
        if (!client.isDryRun && !((response.results as Row[]) ?? [])[0]?.resourceName) {
          return fail(`A API não confirmou o vínculo à conta — confira com list_shared_sets antes de repetir.\n\n${formatJson(response)}`);
        }
        return {
          content: [text(client.isDryRun
            ? `DRY-RUN (validateOnly): vínculo da lista "${set.name}" à conta ${cid} validado — nada foi gravado.`
            : `Lista "${set.name}" vinculada à conta ${cid}: suas ${set.memberCount} palavras agora valem para Pesquisa e Shopping de todas as campanhas.`)],
        };
      }

      if (!CAMPAIGN_ATTACHABLE_TYPES.has(set.type)) {
        const hint = set.type === "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" ? " Use toAccount: true." : "";
        return refuse(`Listas ${set.type} não se vinculam a campanhas por esta tool.${hint}`);
      }
      const campaigns = await readCampaigns(client, customerId, ids);
      const notFound = ids.filter((id) => !campaigns.has(id));
      const removedCampaigns = ids.filter((id) => campaigns.get(id)?.status === "REMOVED");
      const existing = new Set((await readCampaignLinks(client, customerId, ref.resourceName, ids)).map((l) => l.campaignId));
      const alreadyAttached = ids.filter((id) => existing.has(id));
      const toAttach = ids.filter((id) => campaigns.has(id) && !removedCampaigns.includes(id) && !existing.has(id));
      const skipped = {
        already_attached: alreadyAttached,
        not_found: notFound,
        removed_campaigns: removedCampaigns,
      };
      if (!toAttach.length) {
        return {
          content: [text(`Nada a vincular: ${alreadyAttached.length} campanha(s) já têm a lista; ${notFound.length + removedCampaigns.length} inválida(s). ` +
            `Nenhuma escrita foi enviada.\n\n${formatJson(skipped)}`)],
          isError: alreadyAttached.length === 0,
        };
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignSharedSets",
          toAttach.map((id) => ({ create: { campaign: `customers/${cid}/campaigns/${id}`, sharedSet: ref.resourceName } })),
          { partialFailure: true });
      } catch (err) {
        return refuse(`A API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}\n`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, toAttach, dryRun);
      const describe = (id: string) => `${id} (${campaigns.get(id)?.name ?? ""}, ${campaigns.get(id)?.channel ?? ""})`;
      const errors: Row[] = [
        ...report.failed.map((f) => ({ campaign: describe(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `Lista "${set.name}" — DRY-RUN (validateOnly): ${report.ok.length} vínculo(s) validado(s), nada foi gravado.`
            : `Lista "${set.name}" vinculada a ${report.ok.length} campanha(s).`) +
          ` Já tinham: ${alreadyAttached.length} | Inválidas: ${notFound.length + removedCampaigns.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "attached"]: report.ok.map(describe), ...skipped, errors })
        )],
        isError: errors.length > 0 || notFound.length + removedCampaigns.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "detach_shared_set",
    {
      description: [
        "Desvincula uma lista compartilhada de campanhas ou da conta. A lista e as palavras continuam existindo.",
        "WRITE OPERATION — exige confirm: true (sem ele, devolve a prévia): as campanhas passam a receber o",
        "tráfego que a lista bloqueava. Reversível com attach_shared_set.",
        "",
        "- campaignIds: das campanhas indicadas; allCampaigns: true: de todas as campanhas da conta;",
        "- fromAccount: true: deixa de ser a lista de negativas de nível de conta (remove o CustomerNegativeCriterion).",
        "sharedSetId aceita o ID ou o resource name (listas do MCC).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID da conta onde a lista está vinculada."),
        sharedSetId: z.string().describe("ID da lista ou resource name customers/{customerId}/sharedSets/{id}."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas a desvincular."),
        allCampaigns: z.boolean().optional().describe("true = desvincular de todas as campanhas."),
        fromAccount: z.boolean().optional().describe("true = desvincular da conta (lista de nível de conta)."),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar."),
      },
    },
    async ({ customerId, sharedSetId, campaignIds, allCampaigns, fromAccount, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi desvinculado.`);
      const cid = cleanCid(customerId);
      const ref = parseSharedSetRef(sharedSetId, cid);
      if ("error" in ref) return refuse(ref.error);
      const { ids, bad } = parseIds(campaignIds);
      if (bad.length) return refuse(`campaignIds devem ser numéricos: ${bad.join(", ")}.`);
      const modes = [ids.length > 0, allCampaigns === true, fromAccount === true].filter(Boolean).length;
      if (modes !== 1) return refuse("Escolha um: campaignIds, allCampaigns: true ou fromAccount: true.");
      const client = ctx.getClient();

      if (fromAccount === true) {
        const link = (await readAccountListLinks(client, customerId)).find((l) => l.sharedSet === ref.resourceName);
        if (!link) return refuse(`A lista ${ref.resourceName} não é a lista de negativas da conta ${cid}.`);
        if (confirm !== true && !client.isDryRun) {
          return preview(`A conta ${cid} deixaria de excluir as palavras da lista ${ref.resourceName}.`, { remove: link.resourceName });
        }
        let response: Row;
        try {
          response = await client.mutate(customerId, "customerNegativeCriteria", [{ remove: link.resourceName }]);
        } catch (err) {
          return refuse(`A API recusou.\nErro: ${withHint((err as Error).message)}\n`);
        }
        if (!client.isDryRun && !((response.results as Row[]) ?? [])[0]?.resourceName) {
          return fail(`A API não confirmou o desvínculo — confira com list_shared_sets antes de repetir.\n\n${formatJson(response)}`);
        }
        return {
          content: [text(client.isDryRun
            ? `DRY-RUN (validateOnly): desvínculo da lista ${ref.resourceName} da conta ${cid} validado — nada foi gravado.`
            : `Lista ${ref.resourceName} desvinculada da conta ${cid} (a lista continua existindo; attach_shared_set com toAccount revincula).`)],
        };
      }

      const links = await readCampaignLinks(client, customerId, ref.resourceName, allCampaigns ? undefined : ids);
      const linked = new Map(links.map((l) => [l.campaignId, l]));
      const notAttached = ids.filter((id) => !linked.has(id));
      const toDetach = [...linked.values()];
      if (!toDetach.length) {
        return refuse(`A lista ${ref.resourceName} não está vinculada ${allCampaigns ? "a nenhuma campanha" : `às campanhas ${ids.join(", ")}`}.`);
      }
      const describe = (l: { campaignId: string; campaignName: string }) => `${l.campaignId} (${l.campaignName})`;
      if (confirm !== true && !client.isDryRun) {
        return preview(`A lista ${ref.resourceName} sairia de ${toDetach.length} campanha(s).`,
          { to_detach: toDetach.map(describe), not_attached: notAttached });
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignSharedSets", toDetach.map((l) => ({ remove: l.resourceName })), { partialFailure: true });
      } catch (err) {
        return refuse(`A API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}\n`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, toDetach, dryRun);
      const errors: Row[] = [
        ...report.failed.map((f) => ({ campaign: describe(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): ${report.ok.length} desvínculo(s) validado(s), nada foi gravado.`
            : `Lista ${ref.resourceName} desvinculada de ${report.ok.length} campanha(s).`) +
          ` | Não vinculadas: ${notAttached.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "detached"]: report.ok.map(describe), not_attached: notAttached, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );

  // ── Escrita: lista de nível de conta ────────────────────────────────

  ctx.mcp.registerTool(
    "add_account_negative_keywords",
    {
      description: [
        "Adiciona palavras-chave negativas de nível de conta: valem para Pesquisa e Shopping de TODAS as campanhas",
        "(Pesquisa, Shopping, Performance Max, App, Smart, Local). Display e Vídeo não usam essas negativas.",
        "WRITE OPERATION — exige confirm: true (sem ele, devolve a prévia).",
        "",
        "Usa a lista ACCOUNT_LEVEL_NEGATIVE_KEYWORDS vinculada à conta. Se não houver, usa a lista desse tipo que já",
        "existir na conta ou cria uma — lista, palavras e vínculo numa operação atômica (googleAds:mutate).",
        `Limite: ${NEGATIVE_LIMITS.accountLevel} negativas por conta. Palavras já presentes são puladas.`,
        "Se a lista da conta for de um MCC, a tool recusa: edite no MCC com update_shared_set_members.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(keywordSchema).describe("Negativas [{text, matchType}]."),
        listName: z.string().optional().describe(`Nome da lista, se ela precisar ser criada. Padrão: "${ACCOUNT_LIST_DEFAULT_NAME}".`),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar."),
      },
    },
    async ({ customerId, keywords, listName, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi adicionado.`);
      const parsed = parseKeywords(ensureArray<unknown>(keywords));
      if (parsed.invalid.length) return refuse(`Negativas inválidas:\n- ${parsed.invalid.join("\n- ")}\n`);
      if (!parsed.keywords.length) return refuse("Informe keywords [{text, matchType}].");
      if (parsed.keywords.length > NEGATIVE_LIMITS.accountLevel) {
        return refuse(`${parsed.keywords.length} negativas — o limite de nível de conta é ${NEGATIVE_LIMITS.accountLevel}.`);
      }
      const name = cleanText(listName ?? ACCOUNT_LIST_DEFAULT_NAME);
      const nameBytes = Buffer.byteLength(name, "utf8");
      if (nameBytes < 1 || nameBytes > 255) return refuse(`listName deve ter de 1 a 255 bytes (recebido ${nameBytes}).`);

      const client = ctx.getClient();
      const cid = cleanCid(customerId);
      const links = await readAccountListLinks(client, customerId);
      const link = links[0];
      if (link && ownerOf(link.sharedSet) !== cid) {
        return refuse(`A lista de negativas desta conta é ${link.sharedSet}, da conta ${ownerOf(link.sharedSet)} (MCC). ` +
          `Mudá-la afeta todas as contas que a usam: edite com update_shared_set_members customerId=${ownerOf(link.sharedSet)}.`);
      }

      let set: SharedSetInfo | undefined;
      let mode: "linked" | "link-existing" | "create";
      if (link) {
        set = await readSharedSet(client, customerId, lastId(link.sharedSet));
        if (!set) return refuse(`A lista vinculada (${link.sharedSet}) não foi encontrada.`);
        if (set.status !== "ENABLED") {
          return refuse(`A lista vinculada à conta (${link.sharedSet}) está ${set.status}. Desvincule-a (detach_shared_set fromAccount) e rode de novo.`);
        }
        mode = "linked";
      } else {
        const candidates = (await client.searchStream(customerId,
          `SELECT ${SHARED_SET_FIELDS}
           FROM shared_set
           WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'
             AND shared_set.status = 'ENABLED'`)).map(toSharedSet);
        if (candidates.length > 1) {
          return refuse(`A conta tem ${candidates.length} listas de nível de conta sem vínculo: ` +
            `${candidates.map((s) => `${s.name} (${s.id})`).join(", ")}. Escolha uma com attach_shared_set (toAccount: true).`);
        }
        set = candidates[0];
        mode = set ? "link-existing" : "create";
      }
      const members = set ? await readSharedSetKeywords(client, customerId, set.id) : [];
      const memberKeys = new Set(members.map(keywordKey));
      const alreadyPresent = parsed.keywords.filter((k) => memberKeys.has(keywordKey(k))).map(describeKeyword);
      const toAdd = parsed.keywords.filter((k) => !memberKeys.has(keywordKey(k)));
      const total = members.length + toAdd.length;
      if (total > NEGATIVE_LIMITS.accountLevel) {
        return refuse(`A conta ficaria com ${total} negativas de nível de conta (tem ${members.length}); o limite é ${NEGATIVE_LIMITS.accountLevel}.`);
      }
      const plan = {
        list: set ? { id: set.id, name: set.name, member_count: members.length } : { create: name },
        step: mode === "linked" ? "adicionar à lista já vinculada"
          : mode === "link-existing" ? "adicionar à lista existente e vinculá-la à conta" : "criar a lista, adicionar e vincular à conta",
        to_add: toAdd.map(describeKeyword),
        already_present: alreadyPresent,
        duplicates_in_input: parsed.duplicates,
      };
      if (!toAdd.length && mode === "linked") {
        return { content: [text(`Nada a adicionar: as negativas já estão na lista da conta. Nenhuma escrita foi enviada.\n\n${formatJson(plan)}`)] };
      }
      if (confirm !== true && !client.isDryRun) {
        return preview(`Conta ${cid}: ${toAdd.length} negativa(s) de nível de conta — valem para Pesquisa e Shopping de todas as campanhas.`, plan);
      }
      const dryRun = client.isDryRun;

      if (mode === "linked") {
        let response: Row;
        try {
          response = await client.mutate(customerId, "sharedCriteria", toAdd.map((k) => ({
            create: { sharedSet: `customers/${cid}/sharedSets/${set!.id}`, keyword: { text: k.text, matchType: k.matchType } },
          })), { partialFailure: true });
        } catch (err) {
          return refuse(`A API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}\n`);
        }
        const report = perOperation(response, toAdd, dryRun);
        const errors: Row[] = [
          ...report.failed.map((f) => ({ keyword: describeKeyword(f.item), error: f.error })),
          ...report.unattributed.map((error) => ({ error })),
        ];
        return {
          content: [text(
            (dryRun ? `Conta ${cid} — DRY-RUN (validateOnly): ${report.ok.length} negativa(s) validada(s), nada foi gravado.`
              : `Conta ${cid}: ${report.ok.length} negativa(s) de nível de conta adicionada(s) na lista "${set!.name}".`) +
            ` Já existiam: ${alreadyPresent.length} | Com erro: ${errors.length}\n\n` +
            formatJson({ [dryRun ? "validated" : "added"]: report.ok.map(describeKeyword), already_present: alreadyPresent, errors })
          )],
          isError: errors.length > 0,
        };
      }

      // Sem vínculo: uma operação atômica (lista nova ou existente + palavras + vínculo à conta).
      const setResource = set ? `customers/${cid}/sharedSets/${set.id}` : `customers/${cid}/sharedSets/-1`;
      const operations: Row[] = [
        ...(set ? [] : [{ sharedSetOperation: { create: { resourceName: setResource, name, type: "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" } } }]),
        ...toAdd.map((k) => ({
          sharedCriterionOperation: { create: { sharedSet: setResource, keyword: { text: k.text, matchType: k.matchType } } },
        })),
        { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: setResource } } } },
      ];
      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return refuse(`A API recusou (operação atômica: ${set ? "" : "lista, "}palavras e vínculo à conta).\nErro: ${withHint((err as Error).message)}\n`);
      }
      const responses = (response.mutateOperationResponses as Row[]) ?? [];
      const linked = responses.some((r) => r.customerNegativeCriterionResult);
      if (!dryRun && !linked) {
        return fail(`A API não confirmou o vínculo da lista à conta — confira com list_shared_sets antes de repetir.\n\n${formatJson(response)}`);
      }
      const createdSet = ((responses.find((r) => r.sharedSetResult)?.sharedSetResult ?? {}) as Row).resourceName;
      return {
        content: [text(
          (dryRun ? `Conta ${cid} — DRY-RUN (validateOnly): lista, ${toAdd.length} negativa(s) e vínculo validados — nada foi gravado.\n`
            : `Conta ${cid}: ${toAdd.length} negativa(s) de nível de conta adicionada(s).\n`) +
          `- Lista: ${set ? `"${set.name}" (${set.id}, já existia)` : `"${name}" ${createdSet ? `criada: ${createdSet}` : "(nova)"}`}\n` +
          `- Vinculada à conta: ${dryRun ? "validado" : "sim"}\n` +
          (alreadyPresent.length ? `- Já existiam: ${alreadyPresent.join(", ")}\n` : "")
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "remove_account_negative_keywords",
    {
      description: [
        "Remove palavras-chave negativas de nível de conta (da lista vinculada à conta).",
        "WRITE OPERATION — exige confirm: true (sem ele, devolve a prévia): as palavras voltam a poder acionar",
        "anúncios em todas as campanhas. Reversível com add_account_negative_keywords.",
        "Identifique por keywords [{text, matchType}] ou criterionIds (list_negative_keywords source ACCOUNT).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(keywordSchema).optional().describe("Negativas a remover."),
        criterionIds: flexArray(z.string()).optional().describe("criterion_id das negativas."),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar."),
      },
    },
    async ({ customerId, keywords, criterionIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const refuse = (message: string) => fail(`${message} Nada foi removido.`);
      const wanted = parseKeywords(ensureArray<unknown>(keywords));
      if (wanted.invalid.length) return refuse(`keywords inválidas:\n- ${wanted.invalid.join("\n- ")}\n`);
      const { ids, bad } = parseIds(criterionIds);
      if (bad.length) return refuse(`criterionIds devem ser numéricos: ${bad.join(", ")}.`);
      if (!wanted.keywords.length && !ids.length) return refuse("Informe keywords ou criterionIds.");

      const client = ctx.getClient();
      const cid = cleanCid(customerId);
      const link = (await readAccountListLinks(client, customerId))[0];
      if (!link) return refuse(`A conta ${cid} não tem lista de negativas de nível de conta vinculada.`);
      if (ownerOf(link.sharedSet) !== cid) {
        return refuse(`A lista de negativas desta conta é ${link.sharedSet}, do MCC ${ownerOf(link.sharedSet)} — ` +
          `edite com update_shared_set_members customerId=${ownerOf(link.sharedSet)}.`);
      }
      const members = await readSharedSetKeywords(client, customerId, lastId(link.sharedSet));
      const targets = new Map<string, ExistingNegative>();
      const notFound: string[] = [];
      for (const id of ids) {
        const found = members.find((m) => m.criterionId === id);
        if (found) targets.set(found.resourceName, found);
        else notFound.push(`criterionId ${id}`);
      }
      for (const k of wanted.keywords) {
        const found = members.find((m) => keywordKey(m) === keywordKey(k));
        if (found) targets.set(found.resourceName, found);
        else notFound.push(describeKeyword(k));
      }
      const toRemove = [...targets.values()];
      const describe = (m: ExistingNegative) => ({ criterion_id: m.criterionId, keyword: describeKeyword(m) });
      if (!toRemove.length) return refuse(`Nenhuma das negativas pedidas está na lista da conta.\nNão encontradas: ${notFound.join(", ")}\n`);
      if (confirm !== true && !client.isDryRun) {
        return preview(`Conta ${cid}: ${toRemove.length} negativa(s) de nível de conta seriam removidas.`,
          { to_remove: toRemove.map(describe), not_found: notFound });
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "sharedCriteria", toRemove.map((m) => ({ remove: m.resourceName })), { partialFailure: true });
      } catch (err) {
        return refuse(`A API recusou o pedido inteiro.\nErro: ${withHint((err as Error).message)}\n`);
      }
      const dryRun = client.isDryRun;
      const report = perOperation(response, toRemove, dryRun);
      const errors: Row[] = [
        ...report.failed.map((f) => ({ ...describe(f.item), error: f.error })),
        ...report.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `Conta ${cid} — DRY-RUN (validateOnly): nada foi removido. Validadas: ${report.ok.length}`
            : `Conta ${cid}: ${report.ok.length} negativa(s) de nível de conta removida(s)`) +
          ` | Não encontradas: ${notFound.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "removed"]: report.ok.map(describe), not_found: notFound, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );
}
