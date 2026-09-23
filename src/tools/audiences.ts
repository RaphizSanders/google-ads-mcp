/**
 * Lote audiences: Públicos, remarketing e Customer Match.
 *
 * Tools novas registradas aqui (classificadas em audiences.catalog.ts) e as implementações
 * das tools antigas do núcleo que este lote corrige (create_audience_segment,
 * update_ad_group_targeting, create_remarketing_list, update_remarketing_list,
 * list_remarketing_lists, list_audience_segments): em src/tools.ts elas conferem a conta e
 * delegam para as funções exportadas deste arquivo.
 *
 * Fonte de verdade (v25): resources/custom_audience.proto, resources/user_list.proto,
 * common/user_lists.proto, common/criteria.proto, resources/{campaign,ad_group}_criterion.proto,
 * common/targeting_setting.proto, errors/criterion_error.proto, errors/user_list_error.proto,
 * errors/custom_audience_error.proto, services/offline_user_data_job_service.proto e as páginas
 * de remarketing/targeting da documentação — ver docs/batches/audiences.md.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  addMetrics,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  emptyTotals,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  metricsView,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { MetricTotals, ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
export type AudienceToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Utilitários ──────────────────────────────────────────────────────

const ID = /^\d+$/;
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const done = (message: string): AudienceToolResult => ({ content: [text(message)] });
const refuse = (message: string): AudienceToolResult => ({ content: [text(message)], isError: true });
const cleanCid = (customerId: string) => customerId.replace(/-/g, "");
const lastSegment = (resourceName: unknown) => String(resourceName ?? "").split("/").pop() ?? "";
const idOfResource = (resourceName: unknown) => lastSegment(resourceName).split("~").pop() ?? "";

function badCustomer(customerId: string): AudienceToolResult | null {
  return ID.test(cleanCid(customerId)) ? null : refuse(`customerId inválido: "${customerId}". Use só dígitos (com ou sem hífens).`);
}

function toStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Literal para LIKE: escapa aspas/barra (gaqlLiteral) e trata [ ] % _ como caracteres, entre colchetes (gramática GAQL). */
export function likeLiteral(value: string): string {
  return gaqlLiteral(value).replace(/[[\]%_]/g, (ch) => `[${ch}]`);
}

function mutateResults(response: Row): Row[] {
  return list(response.results);
}

/** Acrescenta dicas em PT-BR às recusas conhecidas da API (o texto original é mantido). */
export function explainAudienceError(message: string): string {
  const hints: string[] = [];
  if (/similar/i.test(message)) hints.push("Listas SIMILAR (públicos semelhantes) foram descontinuadas e não podem ser alvo nem exclusão.");
  if (/closed user ?list/i.test(message)) hints.push("A lista está CLOSED (não acumula membros): reabra com update_remarketing_list antes de segmentar.");
  if (/audience[_ ]grouped/i.test(message)) hints.push("use_audience_grouped é definido na criação do grupo (imutável): Audience só em grupos com ele = true; segmentos (listas, interesses) só em grupos com ele = false.");
  if (/customer match/i.test(message)) hints.push("A política de Customer Match não permite segmentar esta lista neste contexto.");
  if (/user interests? to search/i.test(message)) hints.push("A API recusou interesse (afinidade/no mercado) nesta campanha de Pesquisa.");
  if (/both.*campaign.*ad group|campaign level and the ad group level/i.test(message)) hints.push("Lista positiva não pode ficar na campanha e no grupo ao mesmo tempo.");
  if (/allowlist|allow-list|not allowlisted/i.test(message)) hints.push("A conta/projeto não está liberado pelo Google para este recurso.");
  if (/name.*(already|used)|duplicate/i.test(message)) hints.push("Já existe um público com esse nome (a API compara sem diferenciar maiúsculas).");
  return hints.length ? `${message}\nDica: ${hints.join(" ")}` : message;
}

// ── Segmento de targeting (DG, Display, Pesquisa, Vídeo) ─────────────

export const SEGMENT_TYPES = ["USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE", "COMBINED_AUDIENCE", "LIFE_EVENT", "AUDIENCE"] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

const SEGMENT_COLLECTION: Record<SegmentType, string> = {
  USER_LIST: "userLists",
  USER_INTEREST: "userInterests",
  CUSTOM_AUDIENCE: "customAudiences",
  COMBINED_AUDIENCE: "combinedAudiences",
  LIFE_EVENT: "lifeEvents",
  AUDIENCE: "audiences",
};

/** Tipo do segmento pela coleção do resource name (customers/{cid}/userLists/{id} → USER_LIST). */
export function inferSegmentType(resourceName: string): SegmentType | undefined {
  const collection = /^customers\/[\d-]+\/([A-Za-z]+)\/\d+$/.exec(resourceName.trim())?.[1];
  return (Object.keys(SEGMENT_COLLECTION) as SegmentType[]).find((type) => SEGMENT_COLLECTION[type] === collection);
}

/** Aceita o ID numérico ou o resource name do segmento; recusa resource name de outra conta/coleção. */
export function parseSegmentRef(
  type: SegmentType,
  ref: string,
  cid: string
): { id: string; resourceName: string } | { error: string } {
  const value = ref.trim();
  const collection = SEGMENT_COLLECTION[type];
  if (ID.test(value)) return { id: value, resourceName: `customers/${cid}/${collection}/${value}` };
  const match = /^customers\/([\d-]+)\/([A-Za-z]+)\/(\d+)$/.exec(value);
  if (!match || match[2] !== collection) {
    return { error: `"${ref}" não é um ${type} válido (esperado o ID numérico ou customers/{customerId}/${collection}/{id}).` };
  }
  const owner = match[1].replace(/-/g, "");
  if (owner !== cid) return { error: `${value} pertence à conta ${owner}, não à conta ${cid}.` };
  return { id: match[3], resourceName: `customers/${cid}/${collection}/${match[3]}` };
}

/** Oneof do critério (AdGroupCriterion/CampaignCriterion) para o segmento. */
function criterionPayload(type: SegmentType, id: string, resourceName: string): Row {
  switch (type) {
    case "USER_LIST": return { userList: { userList: resourceName } };
    case "USER_INTEREST": return { userInterest: { userInterestCategory: resourceName } };
    case "CUSTOM_AUDIENCE": return { customAudience: { customAudience: resourceName } };
    case "COMBINED_AUDIENCE": return { combinedAudience: { combinedAudience: resourceName } };
    // LifeEventInfo leva o ID da taxonomia, não o resource name
    case "LIFE_EVENT": return { lifeEvent: { lifeEventId: id } };
    case "AUDIENCE": return { audience: { audience: resourceName } };
  }
}

/** Chave "TIPO:id" de um critério lido da API (campaign_criterion ou ad_group_criterion). */
function criterionSegmentKey(criterion: Row): string | undefined {
  const type = String(criterion.type ?? "");
  const value =
    type === "USER_LIST" ? obj(criterion.userList).userList :
    type === "USER_INTEREST" ? obj(criterion.userInterest).userInterestCategory :
    type === "CUSTOM_AUDIENCE" ? obj(criterion.customAudience).customAudience :
    type === "COMBINED_AUDIENCE" ? obj(criterion.combinedAudience).combinedAudience :
    type === "LIFE_EVENT" ? obj(criterion.lifeEvent).lifeEventId :
    type === "AUDIENCE" ? obj(criterion.audience).audience : undefined;
  if (value === undefined || value === null || value === "") return undefined;
  return `${type}:${lastSegment(value)}`;
}

const AUDIENCE_CRITERION_TYPES = "'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT', 'AUDIENCE'";

// ── Targeting setting (Observação × Segmentação) ─────────────────────

export const TARGETING_DIMENSIONS = ["AUDIENCE", "AGE_RANGE", "GENDER", "PARENTAL_STATUS", "INCOME_RANGE", "TOPIC", "PLACEMENT", "KEYWORD"] as const;
type Restriction = { targetingDimension: string; bidOnly: boolean };

function readRestrictions(entity: Row): Restriction[] {
  return list(obj(entity.targetingSetting).targetRestrictions).map((r) => ({
    targetingDimension: String(r.targetingDimension ?? ""),
    // bid_only ausente = false (Segmentação), o padrão da API
    bidOnly: r.bidOnly === true,
  }));
}

function modeOf(restrictions: Restriction[], dimension = "AUDIENCE"): { mode: "OBSERVATION" | "TARGETING"; explicit: boolean } {
  const found = restrictions.find((r) => r.targetingDimension === dimension);
  if (!found) return { mode: "TARGETING", explicit: false };
  return { mode: found.bidOnly ? "OBSERVATION" : "TARGETING", explicit: true };
}

/** Lista inteira de restrições com uma dimensão trocada — a API apaga o que não for reenviado. */
function withDimensionMode(restrictions: Restriction[], dimension: string, mode: "OBSERVATION" | "TARGETING"): Restriction[] {
  const next = restrictions.filter((r) => r.targetingDimension !== dimension);
  next.push({ targetingDimension: dimension, bidOnly: mode === "OBSERVATION" });
  return next;
}

const MODE_LABEL: Record<string, string> = { OBSERVATION: "Observação (bid_only=true)", TARGETING: "Segmentação (bid_only=false)" };

// ── Custom audiences (segmentos personalizados) ──────────────────────

type CustomMember =
  | { memberType: "KEYWORD"; keyword: string }
  | { memberType: "URL"; url: string }
  | { memberType: "APP"; app: string }
  | { memberType: "PLACE_CATEGORY"; placeCategory: string };

const APP_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function memberKey(member: Row): string {
  const type = String(member.memberType ?? "");
  const value = member.keyword ?? member.url ?? member.app ?? member.placeCategory ?? "";
  return `${type}:${String(value).trim().toLowerCase()}`;
}

function describeMember(member: Row): string {
  const type = String(member.memberType ?? "");
  const value = member.keyword ?? member.url ?? member.app ?? member.placeCategory ?? "";
  return `${type}: ${value}`;
}

/** Monta CustomAudienceMember {member_type + oneof} validando os limites do proto. */
export function buildCustomAudienceMembers(input: { keywords?: unknown; urls?: unknown; apps?: unknown }): { members: CustomMember[]; errors: string[] } {
  const members: CustomMember[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const push = (member: CustomMember) => {
    const key = memberKey(member as unknown as Row);
    if (seen.has(key)) return;
    seen.add(key);
    members.push(member);
  };
  for (const raw of toStrings(input.keywords)) {
    const keyword = raw.replace(/\s+/g, " ");
    // proto: keyword ou frase de no máximo 10 palavras e 80 caracteres
    if (keyword.length > 80) errors.push(`keyword com mais de 80 caracteres: "${keyword.slice(0, 40)}…"`);
    else if (keyword.split(" ").length > 10) errors.push(`keyword com mais de 10 palavras: "${keyword}"`);
    else push({ memberType: "KEYWORD", keyword });
  }
  for (const url of toStrings(input.urls)) {
    // proto: URL HTTP com protocolo, até 2048 caracteres
    if (!/^https?:\/\/\S+$/i.test(url)) errors.push(`URL sem http(s):// ou com espaço: "${url}"`);
    else if (url.length > 2048) errors.push(`URL com mais de 2048 caracteres: "${url.slice(0, 40)}…"`);
    else push({ memberType: "URL", url });
  }
  for (const app of toStrings(input.apps)) {
    if (!APP_PACKAGE.test(app)) errors.push(`app deve ser o pacote Android (ex.: com.empresa.app), recebido "${app}"`);
    else push({ memberType: "APP", app });
  }
  return { members, errors };
}

export async function createCustomAudience(
  client: GoogleAdsClient,
  customerId: string,
  args: { name: string; description?: string; type?: string; keywords?: unknown; urls?: unknown; apps?: unknown }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const name = String(args.name ?? "").trim();
  if (!name) return refuse("name é obrigatório. Nada foi criado.");
  const type = args.type ?? "AUTO";
  if (type !== "AUTO" && type !== "SEARCH") {
    return refuse(`type "${type}" não é aceito em públicos novos: use AUTO ou SEARCH (INTEREST/PURCHASE_INTENT só existem em públicos antigos). Nada foi criado.`);
  }
  const { members, errors } = buildCustomAudienceMembers(args);
  if (errors.length) return refuse(`Membros inválidos — nada foi criado:\n- ${errors.join("\n- ")}`);
  if (members.length === 0) return refuse("Informe ao menos um membro: keywords, urls ou apps. Nada foi criado.");

  // NAME_ALREADY_USED compara sem diferenciar maiúsculas: confere antes de gravar
  const existing = await client.searchStream(customerId,
    `SELECT custom_audience.id, custom_audience.name, custom_audience.status FROM custom_audience`);
  const clash = existing.map((r) => obj(r.customAudience))
    .find((ca) => String(ca.name ?? "").trim().toLowerCase() === name.toLowerCase() && ca.status !== "REMOVED");
  if (clash) {
    return refuse(`Já existe o segmento personalizado "${clash.name}" (ID ${clash.id}) nesta conta. Use update_custom_audience para mudar os membros. Nada foi criado.`);
  }

  const create: Row = { name, type, members };
  if (args.description?.trim()) create.description = args.description.trim();
  let response: Row;
  try {
    response = await client.mutate(customerId, "customAudiences", [{ create }]);
  } catch (err) {
    return refuse(`A API recusou o segmento — nada foi criado.\n${explainAudienceError((err as Error).message)}`);
  }
  const resourceName = String(mutateResults(response)[0]?.resourceName ?? "");
  const summary = { name, type, members: members.map((m) => describeMember(m as unknown as Row)) };
  if (client.isDryRun) {
    return done(`Segmento personalizado "${name}" — DRY-RUN (validateOnly): validado, nada foi gravado.\n\n${formatJson(summary)}`);
  }
  if (!resourceName) return refuse(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(response)}`);
  return done(
    `Segmento personalizado criado: "${name}"\nResource: ${resourceName}\nID: ${idOfResource(resourceName)}\n\n` +
    `Para usar: add_audience_segment_targeting com type CUSTOM_AUDIENCE (Display, Demand Gen, Vídeo; em Pesquisa a API decide). ` +
    `Em PMax, vira sinal via Audience (add_audience_signal).\n\n${formatJson({ ...summary, resource_name: resourceName })}`
  );
}

export async function updateCustomAudience(
  client: GoogleAdsClient,
  customerId: string,
  args: { customAudienceId: string; name?: string; description?: string; membersMode?: string; keywords?: unknown; urls?: unknown; apps?: unknown }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const id = String(args.customAudienceId ?? "").trim();
  if (!ID.test(id)) return refuse(`customAudienceId deve ser numérico, recebido "${args.customAudienceId}". Nada foi alterado.`);
  const mode = args.membersMode ?? "add";
  if (!["add", "remove", "replace"].includes(mode)) return refuse(`membersMode inválido: ${mode}. Use add, remove ou replace.`);
  const hasMemberInput = [args.keywords, args.urls, args.apps].some((v) => toStrings(v).length > 0);
  if (args.name === undefined && args.description === undefined && !hasMemberInput) {
    return refuse("Informe ao menos um ajuste: name, description ou membros (keywords/urls/apps). Nada foi alterado.");
  }
  const built = buildCustomAudienceMembers(args);
  // Em remove, só importa o valor: não recusa o que for removido por formato
  if (built.errors.length && mode !== "remove") return refuse(`Membros inválidos — nada foi alterado:\n- ${built.errors.join("\n- ")}`);

  const rows = await client.searchStream(customerId,
    `SELECT custom_audience.id, custom_audience.name, custom_audience.description, custom_audience.type,
            custom_audience.status, custom_audience.members
     FROM custom_audience
     WHERE custom_audience.id = ${id}`);
  const current = obj(rows[0]?.customAudience);
  if (!rows.length || !current.id) return refuse(`Segmento personalizado ${id} não encontrado na conta ${cid}. Nada foi alterado.`);
  if (current.status === "REMOVED") return refuse(`O segmento ${id} está removido (a API não edita segmento removido). Nada foi alterado.`);

  const before = list(current.members);
  const update: Row = { resourceName: `customers/${cid}/customAudiences/${id}` };
  const mask: string[] = [];
  const changes: Row[] = [];
  const warnings: string[] = [];

  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) return refuse("name vazio não é aceito. Nada foi alterado.");
    if (name !== current.name) {
      const all = await client.searchStream(customerId,
        `SELECT custom_audience.id, custom_audience.name, custom_audience.status FROM custom_audience`);
      const clash = all.map((r) => obj(r.customAudience))
        .find((ca) => String(ca.id) !== id && ca.status !== "REMOVED" && String(ca.name ?? "").trim().toLowerCase() === name.toLowerCase());
      if (clash) return refuse(`Já existe o segmento "${clash.name}" (ID ${clash.id}). Nada foi alterado.`);
      update.name = name; mask.push("name"); changes.push({ setting: "name", before: current.name, after: name });
    }
  }
  if (args.description !== undefined && args.description.trim() !== String(current.description ?? "")) {
    update.description = args.description.trim(); mask.push("description");
    changes.push({ setting: "description", before: current.description ?? "", after: args.description.trim() });
  }
  if (hasMemberInput) {
    const wanted = built.members as unknown as Row[];
    // PLACE_CATEGORY não é gerido por esta tool: é preservado como está
    const preserved = before.filter((m) => m.memberType === "PLACE_CATEGORY");
    const managed = before.filter((m) => m.memberType !== "PLACE_CATEGORY");
    let next: Row[];
    if (mode === "replace") {
      next = [...preserved, ...wanted];
      if (preserved.length) warnings.push(`${preserved.length} membro(s) PLACE_CATEGORY foram mantidos (não são geridos por esta tool).`);
    } else if (mode === "add") {
      const keys = new Set(before.map(memberKey));
      const added = wanted.filter((m) => !keys.has(memberKey(m)));
      if (added.length < wanted.length) warnings.push(`${wanted.length - added.length} membro(s) já existiam e foram ignorados.`);
      next = [...before, ...added];
    } else {
      const removeKeys = new Set([
        ...toStrings(args.keywords).map((k) => `KEYWORD:${k.replace(/\s+/g, " ").toLowerCase()}`),
        ...toStrings(args.urls).map((u) => `URL:${u.toLowerCase()}`),
        ...toStrings(args.apps).map((a) => `APP:${a.toLowerCase()}`),
      ]);
      next = managed.filter((m) => !removeKeys.has(memberKey(m)));
      const missing = removeKeys.size - (managed.length - next.length);
      if (missing > 0) warnings.push(`${missing} membro(s) pedidos para remover não existiam.`);
      next = [...preserved, ...next];
    }
    if (next.length === 0) return refuse("O segmento ficaria sem membros — a API exige ao menos um. Nada foi alterado.");
    const beforeKeys = before.map(memberKey).sort().join("|");
    const afterKeys = next.map(memberKey).sort().join("|");
    if (beforeKeys !== afterKeys) {
      // UPDATE com members substitui a lista inteira: envia a lista final completa
      update.members = next.map((m) => {
        const member: Row = { memberType: m.memberType };
        for (const field of ["keyword", "url", "app", "placeCategory"]) if (m[field] !== undefined) member[field] = m[field];
        return member;
      });
      mask.push("members");
      changes.push({ setting: "members", before: before.map(describeMember), after: next.map(describeMember) });
    }
  }

  if (mask.length === 0) {
    return done(`Segmento ${id} ("${current.name}"): nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.${warnings.length ? `\n${warnings.join("\n")}` : ""}`);
  }
  let response: Row;
  try {
    response = await client.mutate(customerId, "customAudiences", [{ update, updateMask: mask.join(",") }]);
  } catch (err) {
    return refuse(`A API recusou a alteração — nada foi gravado.\n${explainAudienceError((err as Error).message)}`);
  }
  return done(
    (client.isDryRun ? `Segmento ${id} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `Segmento ${id} ("${current.name}") atualizado.`) +
    `\n\n${formatJson({ changes, warnings, update_mask: mask, result: response })}`
  );
}

// ── Busca de segmentos ───────────────────────────────────────────────

export const SEARCH_SEGMENT_TYPES = ["AUDIENCE", "USER_LIST", "AFFINITY", "IN_MARKET", "LIFE_EVENT", "DETAILED_DEMOGRAPHIC", "CUSTOM", "COMBINED"] as const;
type SearchSegmentType = (typeof SEARCH_SEGMENT_TYPES)[number];

export async function searchAudienceSegments(
  client: GoogleAdsClient,
  customerId: string,
  args: { type?: string; query?: string; limit?: number; format?: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const type = (args.type ?? "AUDIENCE") as SearchSegmentType;
  if (!SEARCH_SEGMENT_TYPES.includes(type)) return refuse(`type inválido: ${args.type}. Válidos: ${SEARCH_SEGMENT_TYPES.join(", ")}.`);
  const limit = args.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return refuse(`limit deve ser inteiro entre 1 e 1000 (recebido ${args.limit}).`);
  const q = args.query?.trim();
  const like = (field: string) => (q ? `${field} LIKE '%${likeLiteral(q)}%'` : "");
  const where = (...conditions: string[]) => {
    const parts = conditions.filter(Boolean);
    return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  };

  let query: string;
  let map: (r: Row) => Row;
  switch (type) {
    case "USER_LIST":
      query = `SELECT user_list.id, user_list.name, user_list.resource_name, user_list.type, user_list.membership_status,
                      user_list.size_for_display, user_list.size_for_search, user_list.eligible_for_search,
                      user_list.eligible_for_display
               FROM user_list ${where(like("user_list.name"))}
               ORDER BY user_list.name LIMIT ${limit}`;
      map = (r) => {
        const ul = obj(r.userList);
        const notes: string[] = [];
        if (ul.type === "SIMILAR") notes.push("SIMILAR: descontinuada, não pode ser alvo");
        if (ul.membershipStatus === "CLOSED") notes.push("CLOSED: não pode ser alvo positivo");
        return { segment_type: "USER_LIST", targeting_type: ul.type === "SIMILAR" ? null : "USER_LIST", id: ul.id, name: ul.name, resource_name: ul.resourceName,
          list_type: ul.type, membership_status: ul.membershipStatus, size_display: ul.sizeForDisplay, size_search: ul.sizeForSearch,
          eligible_search: ul.eligibleForSearch, eligible_display: ul.eligibleForDisplay, notes };
      };
      break;
    case "AFFINITY":
    case "IN_MARKET":
      query = `SELECT user_interest.user_interest_id, user_interest.name, user_interest.resource_name,
                      user_interest.taxonomy_type, user_interest.user_interest_parent, user_interest.launched_to_all
               FROM user_interest ${where(`user_interest.taxonomy_type = '${type}'`, like("user_interest.name"))}
               ORDER BY user_interest.name LIMIT ${limit}`;
      map = (r) => {
        const ui = obj(r.userInterest);
        return { segment_type: type, targeting_type: "USER_INTEREST", id: ui.userInterestId, name: ui.name, resource_name: ui.resourceName,
          parent: ui.userInterestParent, launched_to_all: ui.launchedToAll };
      };
      break;
    case "LIFE_EVENT":
      query = `SELECT life_event.id, life_event.name, life_event.resource_name, life_event.parent, life_event.launched_to_all
               FROM life_event ${where(like("life_event.name"))}
               ORDER BY life_event.name LIMIT ${limit}`;
      map = (r) => {
        const le = obj(r.lifeEvent);
        return { segment_type: "LIFE_EVENT", targeting_type: "LIFE_EVENT", id: le.id, name: le.name, resource_name: le.resourceName, parent: le.parent, launched_to_all: le.launchedToAll };
      };
      break;
    case "DETAILED_DEMOGRAPHIC":
      query = `SELECT detailed_demographic.id, detailed_demographic.name, detailed_demographic.resource_name,
                      detailed_demographic.parent, detailed_demographic.launched_to_all
               FROM detailed_demographic ${where(like("detailed_demographic.name"))}
               ORDER BY detailed_demographic.name LIMIT ${limit}`;
      map = (r) => {
        const dd = obj(r.detailedDemographic);
        return { segment_type: "DETAILED_DEMOGRAPHIC", targeting_type: null, id: dd.id, name: dd.name, resource_name: dd.resourceName, parent: dd.parent,
          launched_to_all: dd.launchedToAll, notes: ["use dentro de um Audience (PMax/Demand Gen); não é alvo direto em add_audience_segment_targeting"] };
      };
      break;
    case "CUSTOM":
      query = `SELECT custom_audience.id, custom_audience.name, custom_audience.resource_name, custom_audience.type,
                      custom_audience.status, custom_audience.description, custom_audience.members
               FROM custom_audience ${where("custom_audience.status = 'ENABLED'", like("custom_audience.name"))}
               ORDER BY custom_audience.name LIMIT ${limit}`;
      map = (r) => {
        const ca = obj(r.customAudience);
        return { segment_type: "CUSTOM", targeting_type: "CUSTOM_AUDIENCE", id: ca.id, name: ca.name, resource_name: ca.resourceName, audience_type: ca.type,
          description: ca.description, members: list(ca.members).map(describeMember) };
      };
      break;
    case "COMBINED":
      query = `SELECT combined_audience.id, combined_audience.name, combined_audience.resource_name,
                      combined_audience.status, combined_audience.description
               FROM combined_audience ${where("combined_audience.status = 'ENABLED'", like("combined_audience.name"))}
               ORDER BY combined_audience.name LIMIT ${limit}`;
      map = (r) => {
        const ca = obj(r.combinedAudience);
        return { segment_type: "COMBINED", targeting_type: "COMBINED_AUDIENCE", id: ca.id, name: ca.name, resource_name: ca.resourceName, description: ca.description };
      };
      break;
    case "AUDIENCE":
    default:
      query = `SELECT audience.id, audience.name, audience.resource_name, audience.status, audience.description, audience.scope
               FROM audience ${where("audience.status = 'ENABLED'", like("audience.name"))}
               ORDER BY audience.name LIMIT ${limit}`;
      map = (r) => {
        const au = obj(r.audience);
        return { segment_type: "AUDIENCE", targeting_type: "AUDIENCE", id: au.id, name: au.name, resource_name: au.resourceName, scope: au.scope,
          description: au.description, notes: ["alvo só em grupos Demand Gen/App criados com use_audience_grouped=true, ou sinal de PMax"] };
      };
      break;
  }

  const rows = (await client.searchStream(customerId, query)).map(map);
  if (args.format === "table") return done(formatAsTable(rows.map((r) => ({ ...r, members: Array.isArray(r.members) ? (r.members as string[]).join("; ") : r.members, notes: Array.isArray(r.notes) ? (r.notes as string[]).join("; ") : r.notes }))));
  if (args.format === "csv") return done(formatAsCsv(rows.map((r) => ({ ...r, members: Array.isArray(r.members) ? (r.members as string[]).join("; ") : r.members, notes: Array.isArray(r.notes) ? (r.notes as string[]).join("; ") : r.notes }))));
  const hint = q ? "" : "\n(Sem query: primeiros resultados em ordem alfabética.)";
  return done(`${rows.length} segmento(s) ${type}.${hint}\nUse targeting_type + id em add_audience_segment_targeting.\n\n${formatJson(rows)}`);
}

// ── Targeting por segmento (campanha ou grupo) ───────────────────────

export interface SegmentInput {
  type: string;
  id?: string;
  resourceName?: string;
  negative?: boolean;
  bidModifier?: number;
}

interface ResolvedSegment {
  type: SegmentType;
  id: string;
  resourceName: string;
  negative: boolean;
  bidModifier?: number;
  label: string;
}

interface TargetEntity {
  level: "campaign" | "adGroup";
  campaignId: string;
  adGroupId?: string;
  resourceName: string;
  name: string;
  channel: string;
  campaignName: string;
  campaignRestrictions: Restriction[];
  adGroupRestrictions: Restriction[];
  useAudienceGrouped: boolean;
}

/** Lê a campanha ou o grupo alvo (com o canal e os targeting settings dos dois níveis). */
async function readTargetEntity(
  client: GoogleAdsClient,
  customerId: string,
  level: "campaign" | "adGroup",
  id: string
): Promise<TargetEntity | { error: string }> {
  const cid = cleanCid(customerId);
  if (level === "adGroup") {
    const rows = await client.searchStream(customerId,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
              ad_group.audience_setting.use_audience_grouped, ad_group.targeting_setting.target_restrictions,
              campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
              campaign.targeting_setting.target_restrictions
       FROM ad_group
       WHERE ad_group.id = ${id}`);
    const adGroup = obj(rows[0]?.adGroup);
    const campaign = obj(rows[0]?.campaign);
    if (!rows.length || !adGroup.id) return { error: `Grupo de anúncios ${id} não encontrado na conta ${cid}.` };
    if (adGroup.status === "REMOVED") return { error: `O grupo ${id} ("${adGroup.name}") está removido.` };
    if (!ID.test(String(campaign.id ?? ""))) return { error: `A API não devolveu a campanha do grupo ${id}.` };
    return {
      level, campaignId: String(campaign.id ?? ""), adGroupId: id, resourceName: `customers/${cid}/adGroups/${id}`,
      name: String(adGroup.name ?? ""), channel: String(campaign.advertisingChannelType ?? ""), campaignName: String(campaign.name ?? ""),
      campaignRestrictions: readRestrictions(campaign), adGroupRestrictions: readRestrictions(adGroup),
      useAudienceGrouped: obj(adGroup.audienceSetting).useAudienceGrouped === true,
    };
  }
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.advertising_channel_sub_type, campaign.targeting_setting.target_restrictions
     FROM campaign
     WHERE campaign.id = ${id}`);
  const campaign = obj(rows[0]?.campaign);
  if (!rows.length || !campaign.id) return { error: `Campanha ${id} não encontrada na conta ${cid}.` };
  if (campaign.status === "REMOVED") return { error: `A campanha ${id} ("${campaign.name}") está removida.` };
  return {
    level, campaignId: id, resourceName: `customers/${cid}/campaigns/${id}`, name: String(campaign.name ?? ""),
    channel: String(campaign.advertisingChannelType ?? ""), campaignName: String(campaign.name ?? ""),
    campaignRestrictions: readRestrictions(campaign), adGroupRestrictions: [], useAudienceGrouped: false,
  };
}

interface ExistingCriterion {
  level: "campaign" | "adGroup";
  adGroupId?: string;
  criterionId: string;
  resourceName: string;
  type: string;
  key?: string;
  negative: boolean;
  bidModifier?: number;
  displayName?: string;
}

async function readCampaignAudienceCriteria(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<ExistingCriterion[]> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.resource_name, campaign_criterion.type,
            campaign_criterion.negative, campaign_criterion.status, campaign_criterion.bid_modifier,
            campaign_criterion.display_name, campaign_criterion.user_list.user_list,
            campaign_criterion.user_interest.user_interest_category, campaign_criterion.custom_audience.custom_audience,
            campaign_criterion.combined_audience.combined_audience, campaign_criterion.life_event.life_event_id
     FROM campaign_criterion
     WHERE campaign.id = ${campaignId}
       AND campaign_criterion.type IN (${AUDIENCE_CRITERION_TYPES})
       AND campaign_criterion.status != 'REMOVED'`);
  return rows.map((r) => {
    const c = obj(r.campaignCriterion);
    return {
      level: "campaign" as const, criterionId: String(c.criterionId ?? ""), resourceName: String(c.resourceName ?? ""), type: String(c.type ?? ""),
      key: criterionSegmentKey(c), negative: c.negative === true, bidModifier: c.bidModifier === undefined ? undefined : num(c.bidModifier),
      displayName: c.displayName === undefined ? undefined : String(c.displayName),
    };
  });
}

async function readAdGroupAudienceCriteria(
  client: GoogleAdsClient,
  customerId: string,
  filter: { campaignId?: string; adGroupId?: string }
): Promise<ExistingCriterion[]> {
  const where = filter.adGroupId ? `ad_group.id = ${filter.adGroupId}` : `campaign.id = ${filter.campaignId}`;
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.type,
            ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.bid_modifier,
            ad_group_criterion.display_name, ad_group_criterion.user_list.user_list,
            ad_group_criterion.user_interest.user_interest_category, ad_group_criterion.custom_audience.custom_audience,
            ad_group_criterion.combined_audience.combined_audience, ad_group_criterion.life_event.life_event_id,
            ad_group_criterion.audience.audience
     FROM ad_group_criterion
     WHERE ${where}
       AND ad_group_criterion.type IN (${AUDIENCE_CRITERION_TYPES})
       AND ad_group_criterion.status != 'REMOVED'`);
  return rows.map((r) => {
    const c = obj(r.adGroupCriterion);
    return {
      level: "adGroup" as const, adGroupId: String(obj(r.adGroup).id ?? ""), criterionId: String(c.criterionId ?? ""),
      resourceName: String(c.resourceName ?? ""), type: String(c.type ?? ""), key: criterionSegmentKey(c), negative: c.negative === true,
      bidModifier: c.bidModifier === undefined ? undefined : num(c.bidModifier),
      displayName: c.displayName === undefined ? undefined : String(c.displayName),
    };
  });
}

/** Confere na conta cada segmento pedido; devolve o rótulo e os bloqueios (SIMILAR, CLOSED, removido...). */
async function checkSegmentsExist(
  client: GoogleAdsClient,
  customerId: string,
  segments: ResolvedSegment[],
  channel: string
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const idsOf = (type: SegmentType) => [...new Set(segments.filter((s) => s.type === type).map((s) => s.id))];
  const found = new Map<string, Row>();
  const specs: Array<{ type: SegmentType; query: (ids: string) => string; pick: (r: Row) => Row; idField: string }> = [
    { type: "USER_LIST", idField: "id", pick: (r) => obj(r.userList),
      query: (ids) => `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status,
                              user_list.eligible_for_search, user_list.eligible_for_display
                       FROM user_list WHERE user_list.id IN (${ids})` },
    { type: "USER_INTEREST", idField: "userInterestId", pick: (r) => obj(r.userInterest),
      query: (ids) => `SELECT user_interest.user_interest_id, user_interest.name, user_interest.taxonomy_type
                       FROM user_interest WHERE user_interest.user_interest_id IN (${ids})` },
    { type: "CUSTOM_AUDIENCE", idField: "id", pick: (r) => obj(r.customAudience),
      query: (ids) => `SELECT custom_audience.id, custom_audience.name, custom_audience.status
                       FROM custom_audience WHERE custom_audience.id IN (${ids})` },
    { type: "COMBINED_AUDIENCE", idField: "id", pick: (r) => obj(r.combinedAudience),
      query: (ids) => `SELECT combined_audience.id, combined_audience.name, combined_audience.status
                       FROM combined_audience WHERE combined_audience.id IN (${ids})` },
    { type: "LIFE_EVENT", idField: "id", pick: (r) => obj(r.lifeEvent),
      query: (ids) => `SELECT life_event.id, life_event.name FROM life_event WHERE life_event.id IN (${ids})` },
    { type: "AUDIENCE", idField: "id", pick: (r) => obj(r.audience),
      query: (ids) => `SELECT audience.id, audience.name, audience.status, audience.scope
                       FROM audience WHERE audience.id IN (${ids})` },
  ];
  for (const spec of specs) {
    const ids = idsOf(spec.type);
    if (!ids.length) continue;
    const rows = await client.searchStream(customerId, spec.query(ids.join(", ")));
    for (const row of rows) {
      const item = spec.pick(row);
      found.set(`${spec.type}:${String(item[spec.idField] ?? "")}`, item);
    }
  }
  for (const segment of segments) {
    const item = found.get(`${segment.type}:${segment.id}`);
    if (!item) {
      errors.push(`${segment.type} ${segment.id} não existe nesta conta (confira com search_audience_segments).`);
      continue;
    }
    segment.label = `${segment.type} ${segment.id} "${item.name ?? ""}"`;
    if (segment.type === "USER_LIST") {
      if (item.type === "SIMILAR") errors.push(`${segment.label}: listas SIMILAR foram descontinuadas — não podem ser alvo nem exclusão.`);
      if (item.membershipStatus === "CLOSED" && !segment.negative) errors.push(`${segment.label}: lista CLOSED não pode ser alvo positivo (reabra com update_remarketing_list).`);
      if ((channel === "SEARCH" || channel === "SHOPPING") && item.eligibleForSearch === false) warnings.push(`${segment.label}: não é elegível para a rede de Pesquisa (eligible_for_search=false).`);
      if (channel === "DISPLAY" && item.eligibleForDisplay === false) warnings.push(`${segment.label}: não é elegível para a Rede de Display.`);
    }
    if ((segment.type === "CUSTOM_AUDIENCE" || segment.type === "COMBINED_AUDIENCE" || segment.type === "AUDIENCE") && item.status === "REMOVED") {
      errors.push(`${segment.label}: está removido.`);
    }
    if (segment.type === "AUDIENCE" && item.scope === "ASSET_GROUP") {
      errors.push(`${segment.label}: Audience com escopo ASSET_GROUP é exclusivo de um asset group de PMax.`);
    }
  }
  return { errors, warnings };
}

/** Ad groups da campanha com targeting_setting próprio (impede gravar o da campanha). */
async function adGroupsWithOwnSetting(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.targeting_setting.target_restrictions
     FROM ad_group
     WHERE campaign.id = ${campaignId}
       AND ad_group.status != 'REMOVED'`);
  return rows.map((r) => obj(r.adGroup))
    .filter((ag) => readRestrictions(ag).length > 0)
    .map((ag) => ({ id: String(ag.id ?? ""), name: String(ag.name ?? "") }));
}

export async function addAudienceSegmentTargeting(
  client: GoogleAdsClient,
  customerId: string,
  args: { level: string; campaignId?: string; adGroupId?: string; segments: SegmentInput[]; targetingMode?: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const level = args.level === "campaign" ? "campaign" : args.level === "adGroup" ? "adGroup" : undefined;
  if (!level) return refuse(`level deve ser campaign ou adGroup (recebido "${args.level}"). Nada foi alterado.`);
  const targetId = String((level === "campaign" ? args.campaignId : args.adGroupId) ?? "").trim();
  if (!ID.test(targetId)) {
    return refuse(`${level === "campaign" ? "campaignId" : "adGroupId"} é obrigatório e numérico para level=${level} (recebido "${targetId}"). Nada foi alterado.`);
  }
  const requestedMode = args.targetingMode;
  if (requestedMode !== undefined && !["OBSERVATION", "TARGETING", "KEEP"].includes(requestedMode)) {
    return refuse(`targetingMode inválido: ${requestedMode}. Use OBSERVATION, TARGETING ou KEEP.`);
  }
  const inputs = Array.isArray(args.segments) ? args.segments : [];
  if (inputs.length === 0) return refuse("Informe ao menos um segmento em segments. Nada foi alterado.");
  if (inputs.length > 50) return refuse(`No máximo 50 segmentos por chamada (recebidos ${inputs.length}). Nada foi alterado.`);

  // 1. Validação local — nada chega à API com entrada inválida
  const problems: string[] = [];
  const segments: ResolvedSegment[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const where = `segments[${index}]`;
    const type = String(input?.type ?? "") as SegmentType;
    if (!SEGMENT_TYPES.includes(type)) { problems.push(`${where}: type "${input?.type}" inválido (${SEGMENT_TYPES.join(", ")}).`); return; }
    const ref = String(input.resourceName ?? input.id ?? "").trim();
    if (!ref) { problems.push(`${where}: informe id ou resourceName.`); return; }
    const parsed = parseSegmentRef(type, ref, cid);
    if ("error" in parsed) { problems.push(`${where}: ${parsed.error}`); return; }
    const negative = input.negative === true;
    if (input.bidModifier !== undefined) {
      if (negative) { problems.push(`${where}: exclusão (negative=true) não aceita bidModifier.`); return; }
      if (typeof input.bidModifier !== "number" || !Number.isFinite(input.bidModifier) || input.bidModifier < 0.1 || input.bidModifier > 10) {
        problems.push(`${where}: bidModifier deve estar entre 0.1 e 10 (1.2 = +20%, 0.8 = -20%), recebido ${input.bidModifier}.`); return;
      }
    }
    if (type === "AUDIENCE" && level === "campaign") {
      problems.push(`${where}: AUDIENCE só existe como critério de grupo (AdGroupCriterion) — use level=adGroup num grupo Demand Gen/App.`); return;
    }
    const key = `${type}:${parsed.id}`;
    if (seen.has(key)) { problems.push(`${where}: ${key} repetido no pedido.`); return; }
    seen.add(key);
    segments.push({ type, id: parsed.id, resourceName: parsed.resourceName, negative, bidModifier: input.bidModifier, label: `${type} ${parsed.id}` });
  });
  if (problems.length) return refuse(`Pedido inválido — nada foi alterado:\n- ${problems.join("\n- ")}`);

  // 2. Alvo e regras por canal
  const target = await readTargetEntity(client, customerId, level, targetId);
  if ("error" in target) return refuse(`${target.error} Nada foi alterado.`);
  const channel = target.channel;
  if (channel === "PERFORMANCE_MAX") {
    return refuse(`"${target.campaignName}" é Performance Max: PMax não aceita segmentos como critério — use sinais (add_audience_signal). Nada foi alterado.`);
  }
  for (const segment of segments) {
    if (segment.type === "AUDIENCE") {
      if (channel !== "DEMAND_GEN" && channel !== "MULTI_CHANNEL") {
        problems.push(`${segment.label}: Audience como alvo só em Demand Gen e App (campanha é ${channel}); em ${channel} use os segmentos (USER_LIST, USER_INTEREST, CUSTOM_AUDIENCE...).`);
      } else if (!target.useAudienceGrouped) {
        problems.push(`${segment.label}: o grupo "${target.name}" foi criado com use_audience_grouped=false (imutável) — ele aceita segmentos, não Audience. Crie outro grupo com use_audience_grouped=true.`);
      }
    } else if (level === "adGroup" && target.useAudienceGrouped) {
      problems.push(`${segment.label}: o grupo "${target.name}" usa Audience (use_audience_grouped=true) e não aceita segmentos avulsos — inclua o segmento no Audience.`);
    }
    if (segment.type === "USER_LIST" && level === "campaign" && !segment.negative && channel !== "SEARCH") {
      problems.push(`${segment.label}: lista positiva no nível da campanha só é aceita em Pesquisa (campanha é ${channel}). Em ${channel}, na campanha só exclusão (negative=true); para segmentar, use level=adGroup.`);
    }
  }
  if (problems.length) return refuse(`Regras do canal ${channel} — nada foi alterado:\n- ${problems.join("\n- ")}`);

  // 3. Segmentos existem na conta?
  const { errors: segmentErrors, warnings } = await checkSegmentsExist(client, customerId, segments, channel);
  if (segmentErrors.length) return refuse(`Segmentos recusados — nada foi alterado:\n- ${segmentErrors.join("\n- ")}`);

  // 4. Critérios atuais (duplicados, lista positiva nos dois níveis, 1 Audience por grupo)
  const campaignCriteria = await readCampaignAudienceCriteria(client, customerId, target.campaignId);
  const adGroupCriteria = await readAdGroupAudienceCriteria(client, customerId, { campaignId: target.campaignId });
  const sameLevel = level === "campaign" ? campaignCriteria : adGroupCriteria.filter((c) => c.adGroupId === targetId);
  const creates: ResolvedSegment[] = [];
  const bidUpdates: Array<{ segment: ResolvedSegment; existing: ExistingCriterion }> = [];
  const unchanged: string[] = [];
  for (const segment of segments) {
    const key = `${segment.type}:${segment.id}`;
    const existing = sameLevel.find((c) => c.key === key);
    if (existing) {
      if (existing.negative !== segment.negative) {
        problems.push(`${segment.label}: já está ${existing.negative ? "excluído" : "como alvo"} neste ${level === "campaign" ? "nível de campanha" : "grupo"} — remova antes (remove_audience_segment_targeting) para inverter.`);
      } else if (segment.bidModifier !== undefined && Math.abs((existing.bidModifier ?? 1) - segment.bidModifier) > 1e-9) {
        bidUpdates.push({ segment, existing });
      } else {
        unchanged.push(`${segment.label}: já existe (criterion ${existing.criterionId}).`);
      }
      continue;
    }
    if (segment.type === "USER_LIST" && !segment.negative) {
      const otherLevel = level === "campaign"
        ? adGroupCriteria.filter((c) => c.type === "USER_LIST" && !c.negative)
        : campaignCriteria.filter((c) => c.type === "USER_LIST" && !c.negative);
      if (otherLevel.length) {
        problems.push(`${segment.label}: a campanha já tem lista positiva no nível ${level === "campaign" ? "de grupo" : "da campanha"} — a API não aceita listas positivas nos dois níveis ao mesmo tempo.`);
        continue;
      }
    }
    creates.push(segment);
  }
  const newAudiences = creates.filter((s) => s.type === "AUDIENCE").length;
  const oldAudiences = sameLevel.filter((c) => c.type === "AUDIENCE").length;
  if (level === "adGroup" && oldAudiences + newAudiences > 1) {
    problems.push(`O grupo aceita um único Audience (ONE_AUDIENCE_ALLOWED_PER_AD_GROUP): já tem ${oldAudiences}, pedido ${newAudiences}.`);
  }
  if (problems.length) return refuse(`Conflitos com a segmentação atual — nada foi alterado:\n- ${problems.join("\n- ")}`);

  // 5. Modo Observação × Segmentação da dimensão AUDIENCE
  const positivesToCreate = creates.filter((s) => !s.negative);
  const searchLike = channel === "SEARCH" || channel === "SHOPPING";
  const holderLevel: "campaign" | "adGroup" =
    target.campaignRestrictions.length > 0 ? "campaign" : level === "adGroup" ? "adGroup" : "campaign";
  const holderRestrictions = holderLevel === "campaign" ? target.campaignRestrictions : target.adGroupRestrictions;
  const current = modeOf(holderRestrictions);
  let desired: "OBSERVATION" | "TARGETING" | undefined;
  let modeNote = "";
  if (requestedMode === "OBSERVATION" || requestedMode === "TARGETING") {
    desired = requestedMode;
  } else if (requestedMode === undefined && searchLike && positivesToCreate.length && !current.explicit) {
    // Sem restrição AUDIENCE a API aplica Segmentação: o segmento positivo passaria a restringir o alcance
    const positivesInScope = holderLevel === "campaign"
      ? [...campaignCriteria, ...adGroupCriteria].filter((c) => !c.negative)
      : adGroupCriteria.filter((c) => c.adGroupId === targetId && !c.negative);
    if (positivesInScope.length) {
      return refuse(
        `A dimensão AUDIENCE de "${target.name}" está em Segmentação implícita (sem targeting_setting) e já há ` +
        `${positivesInScope.length} segmento(s) positivo(s) restringindo o alcance. Não troco o modo por conta própria: ` +
        `repita com targetingMode OBSERVATION (passa a só observar — amplia o alcance atual) ou TARGETING (mantém a restrição). Nada foi alterado.`
      );
    }
    desired = "OBSERVATION";
    modeNote = `Campanha ${channel}: modo definido como Observação por padrão (sem restrição explícita a API usaria Segmentação e restringiria o alcance aos segmentos).`;
  }
  let settingOp: Row | undefined;
  let settingChange: Row | undefined;
  if (desired && desired !== current.mode && level === "adGroup" && holderLevel === "campaign") {
    // O setting mora na campanha (a API não aceita no grupo enquanto a campanha tiver) e vale para todos os
    // grupos dela: um pedido de grupo nunca troca o modo da campanha inteira — mesma regra do set_targeting_mode.
    const otherGroups = [...new Set(adGroupCriteria.filter((c) => !c.negative && c.adGroupId !== targetId).map((c) => c.adGroupId ?? ""))]
      .filter(Boolean);
    const campaignPositives = campaignCriteria.filter((c) => !c.negative).length;
    const affected = [
      otherGroups.length ? `outros grupos com segmentos positivos: ${otherGroups.slice(0, 10).join(", ")}${otherGroups.length > 10 ? ` (+${otherGroups.length - 10})` : ""}` : "",
      campaignPositives ? `${campaignPositives} segmento(s) positivo(s) no nível da campanha` : "",
    ].filter(Boolean);
    const campaignSetting = target.campaignRestrictions.map((r) => `${r.targetingDimension}=${r.bidOnly ? "OBSERVATION" : "TARGETING"}`).join(", ");
    const reason = requestedMode
      ? `Você pediu targetingMode ${desired}, mas`
      : `Em ${channel} sem restrição AUDIENCE explícita o padrão seria Observação, mas`;
    return refuse(
      `${reason} o targeting_setting de "${target.name}" mora na campanha "${target.campaignName}" (${campaignSetting}) ` +
      `e vale para todos os grupos dela — a API não aceita no grupo enquanto a campanha tiver. Trocar AUDIENCE de ` +
      `${MODE_LABEL[current.mode]}${current.explicit ? "" : " (implícito)"} para ${MODE_LABEL[desired]} a partir de um pedido de grupo ` +
      `mudaria o alcance da campanha inteira${affected.length ? ` (${affected.join("; ")})` : ""}. Não faço isso por conta própria. Nada foi alterado.\n` +
      `Opções: (1) decidir para a campanha inteira com set_targeting_mode level=campaign campaignId=${target.campaignId} mode=${desired} ` +
      `e depois repetir este pedido; (2) repetir com targetingMode KEEP (mantém ${MODE_LABEL[current.mode]}` +
      `${current.mode === "TARGETING" && positivesToCreate.length ? " — o segmento positivo passa a restringir o alcance deste grupo" : ""}).`
    );
  }
  if (desired && desired !== current.mode) {
    if (holderLevel === "campaign" && target.campaignRestrictions.length === 0) {
      const blockers = await adGroupsWithOwnSetting(client, customerId, target.campaignId);
      if (blockers.length) {
        return refuse(
          `Não dá para gravar o targeting_setting na campanha: ${blockers.length} grupo(s) têm o próprio ` +
          `(${blockers.slice(0, 10).map((b) => `${b.id} "${b.name}"`).join(", ")}) e a API não aceita os dois níveis. ` +
          `Use level=adGroup ou set_targeting_mode em cada grupo, ou repita com targetingMode KEEP. Nada foi alterado.`
        );
      }
    }
    const next = withDimensionMode(holderRestrictions, "AUDIENCE", desired);
    const holderResource = holderLevel === "campaign" ? `customers/${cid}/campaigns/${target.campaignId}` : target.resourceName;
    const update = { resourceName: holderResource, targetingSetting: { targetRestrictions: next } };
    settingOp = holderLevel === "campaign"
      ? { campaignOperation: { update, updateMask: "targeting_setting.target_restrictions" } }
      : { adGroupOperation: { update, updateMask: "targeting_setting.target_restrictions" } };
    settingChange = {
      scope: holderLevel === "campaign" ? `campanha ${target.campaignId} (vale para todos os grupos dela)` : `grupo ${targetId}`,
      before: `${MODE_LABEL[current.mode]}${current.explicit ? "" : " — implícito, sem restrição AUDIENCE"}`,
      after: MODE_LABEL[desired],
    };
  }

  if (!creates.length && !bidUpdates.length && !settingOp) {
    return done(`Nada a fazer em "${target.name}": ${unchanged.join(" ")} Nenhuma escrita foi enviada.`);
  }

  // 6. Tudo numa operação atômica (googleAds:mutate): ou grava tudo, ou nada
  const operations: Row[] = [];
  if (settingOp) operations.push(settingOp);
  for (const { segment, existing } of bidUpdates) {
    const update = { resourceName: existing.resourceName, bidModifier: segment.bidModifier };
    operations.push(level === "campaign"
      ? { campaignCriterionOperation: { update, updateMask: "bid_modifier" } }
      : { adGroupCriterionOperation: { update, updateMask: "bid_modifier" } });
  }
  for (const segment of creates) {
    const create: Row = { ...criterionPayload(segment.type, segment.id, segment.resourceName), negative: segment.negative };
    if (segment.bidModifier !== undefined) create.bidModifier = segment.bidModifier;
    if (level === "campaign") operations.push({ campaignCriterionOperation: { create: { campaign: target.resourceName, ...create } } });
    else operations.push({ adGroupCriterionOperation: { create: { adGroup: target.resourceName, ...create } } });
  }
  let response: Row;
  try {
    response = await client.batchMutate(customerId, operations);
  } catch (err) {
    return refuse(`A API recusou — nada foi gravado (operação atômica).\n${explainAudienceError((err as Error).message)}`);
  }
  const responses = list(response.mutateOperationResponses);
  const createdNames = responses
    .map((r) => obj(r[level === "campaign" ? "campaignCriterionResult" : "adGroupCriterionResult"]).resourceName)
    .filter(Boolean);
  const report = {
    target: `${level === "campaign" ? "campanha" : "grupo"} ${targetId} "${target.name}" (${channel})`,
    created: creates.map((s) => ({ segment: s.label, negative: s.negative, bidModifier: s.bidModifier ?? null })),
    bid_modifier_updated: bidUpdates.map(({ segment, existing }) => ({ segment: segment.label, before: existing.bidModifier ?? null, after: segment.bidModifier })),
    unchanged,
    targeting_mode: settingChange ?? { effective: `${MODE_LABEL[current.mode]}${current.explicit ? "" : " (implícito)"}`, changed: false },
    notes: [modeNote].filter(Boolean),
    warnings,
    resource_names: createdNames,
  };
  if (client.isDryRun) return done(`DRY-RUN (validateOnly): validado, nada foi gravado.\n\n${formatJson(report)}`);
  return done(`Segmentação de público aplicada em "${target.name}".\n\n${formatJson(report)}`);
}

export async function removeAudienceSegmentTargeting(
  client: GoogleAdsClient,
  customerId: string,
  args: { level: string; campaignId?: string; adGroupId?: string; criterionIds?: unknown; segments?: Array<{ type: string; id?: string; resourceName?: string }>; confirm?: boolean }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const level = args.level === "campaign" ? "campaign" : args.level === "adGroup" ? "adGroup" : undefined;
  if (!level) return refuse(`level deve ser campaign ou adGroup (recebido "${args.level}"). Nada foi removido.`);
  const targetId = String((level === "campaign" ? args.campaignId : args.adGroupId) ?? "").trim();
  if (!ID.test(targetId)) return refuse(`${level === "campaign" ? "campaignId" : "adGroupId"} é obrigatório e numérico. Nada foi removido.`);
  const ids = toStrings(args.criterionIds);
  const badIds = ids.filter((id) => !ID.test(id));
  if (badIds.length) return refuse(`criterionIds devem ser numéricos: ${badIds.join(", ")}. Nada foi removido.`);
  const wantedKeys: string[] = [];
  for (const [index, segment] of (args.segments ?? []).entries()) {
    const type = String(segment?.type ?? "") as SegmentType;
    if (!SEGMENT_TYPES.includes(type)) return refuse(`segments[${index}]: type inválido "${segment?.type}". Nada foi removido.`);
    const parsed = parseSegmentRef(type, String(segment.resourceName ?? segment.id ?? ""), cid);
    if ("error" in parsed) return refuse(`segments[${index}]: ${parsed.error} Nada foi removido.`);
    wantedKeys.push(`${type}:${parsed.id}`);
  }
  if (!ids.length && !wantedKeys.length) return refuse("Informe criterionIds ou segments. Nada foi removido.");

  const existing = level === "campaign"
    ? await readCampaignAudienceCriteria(client, customerId, targetId)
    : await readAdGroupAudienceCriteria(client, customerId, { adGroupId: targetId });
  const targets = new Map<string, ExistingCriterion>();
  const notFound: string[] = [];
  for (const id of ids) {
    const found = existing.find((c) => c.criterionId === id);
    if (found) targets.set(found.resourceName, found); else notFound.push(`criterion ${id}`);
  }
  for (const key of wantedKeys) {
    const found = existing.find((c) => c.key === key);
    if (found) targets.set(found.resourceName, found); else notFound.push(key);
  }
  const toRemove = [...targets.values()];
  if (!toRemove.length) {
    return refuse(`Nenhum dos segmentos pedidos está no ${level === "campaign" ? "nível da campanha" : "grupo"} ${targetId}. Nada foi removido.\nNão encontrados: ${notFound.join(", ")}`);
  }
  const describe = (c: ExistingCriterion) => ({ criterion_id: c.criterionId, type: c.type, name: c.displayName ?? "", negative: c.negative });
  if (args.confirm !== true) {
    return refuse(
      `Remoção pede confirm: true. Seriam removidos ${toRemove.length} critério(s) — tirar uma exclusão volta a mostrar anúncios para esse público; ` +
      `tirar um alvo em modo Segmentação amplia o alcance.\n\n${formatJson({ would_remove: toRemove.map(describe), not_found: notFound })}`
    );
  }
  const resource = level === "campaign" ? "campaignCriteria" : "adGroupCriteria";
  let response: Row;
  try {
    response = await client.mutate(customerId, resource, toRemove.map((c) => ({ remove: c.resourceName })), { partialFailure: true });
  } catch (err) {
    return refuse(`A API recusou — nada foi removido.\n${explainAudienceError((err as Error).message)}`);
  }
  const dryRun = client.isDryRun;
  const results = mutateResults(response);
  const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, toRemove.length);
  const removed: Row[] = [];
  const errors: Row[] = [];
  toRemove.forEach((criterion, index) => {
    const opErrors = byIndex.get(index);
    if (opErrors) errors.push({ ...describe(criterion), error: opErrors.join("; ") });
    else if (!dryRun && !results[index]?.resourceName) errors.push({ ...describe(criterion), error: "a API não confirmou a remoção" });
    else removed.push(describe(criterion));
  });
  for (const message of unattributed) errors.push({ error: message });
  return {
    content: [text(
      (dryRun ? `DRY-RUN (validateOnly): nada foi removido. Validados: ${removed.length}` : `${removed.length} critério(s) de público removido(s)`) +
      ` | Não encontrados: ${notFound.length} | Com erro: ${errors.length}\n\n` +
      formatJson({ [dryRun ? "validated" : "removed"]: removed, not_found: notFound, errors })
    )],
    isError: errors.length > 0,
  };
}

export async function setTargetingMode(
  client: GoogleAdsClient,
  customerId: string,
  args: { level: string; campaignId?: string; adGroupId?: string; dimension?: string; mode: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const level = args.level === "campaign" ? "campaign" : args.level === "adGroup" ? "adGroup" : undefined;
  if (!level) return refuse(`level deve ser campaign ou adGroup (recebido "${args.level}"). Nada foi alterado.`);
  const targetId = String((level === "campaign" ? args.campaignId : args.adGroupId) ?? "").trim();
  if (!ID.test(targetId)) return refuse(`${level === "campaign" ? "campaignId" : "adGroupId"} é obrigatório e numérico. Nada foi alterado.`);
  const dimension = args.dimension ?? "AUDIENCE";
  if (!(TARGETING_DIMENSIONS as readonly string[]).includes(dimension)) return refuse(`dimension inválida: ${dimension}. Válidas: ${TARGETING_DIMENSIONS.join(", ")}.`);
  const mode = args.mode;
  if (mode !== "OBSERVATION" && mode !== "TARGETING") return refuse(`mode deve ser OBSERVATION ou TARGETING (recebido "${mode}").`);

  const target = await readTargetEntity(client, customerId, level, targetId);
  if ("error" in target) return refuse(`${target.error} Nada foi alterado.`);
  if (level === "adGroup" && target.campaignRestrictions.length > 0) {
    return refuse(
      `A campanha "${target.campaignName}" já define targeting_setting (${target.campaignRestrictions.map((r) => `${r.targetingDimension}=${r.bidOnly ? "OBSERVATION" : "TARGETING"}`).join(", ")}) ` +
      `e a API não aceita no grupo enquanto a campanha tiver. Use level=campaign (vale para todos os grupos). Nada foi alterado.`
    );
  }
  if (level === "campaign" && target.campaignRestrictions.length === 0) {
    const blockers = await adGroupsWithOwnSetting(client, customerId, targetId);
    if (blockers.length) {
      return refuse(
        `${blockers.length} grupo(s) da campanha têm targeting_setting próprio (${blockers.slice(0, 10).map((b) => `${b.id} "${b.name}"`).join(", ")}) ` +
        `e a API não aceita nos dois níveis. Ajuste grupo a grupo (level=adGroup). Nada foi alterado.`
      );
    }
  }
  const restrictions = level === "campaign" ? target.campaignRestrictions : target.adGroupRestrictions;
  const current = modeOf(restrictions, dimension);
  const label = `${level === "campaign" ? "Campanha" : "Grupo"} ${targetId} "${target.name}" (${target.channel})`;
  if (current.mode === mode) {
    return done(`${label}: ${dimension} já está em ${MODE_LABEL[mode]}${current.explicit ? "" : " (implícito — padrão da API sem restrição)"}. Nenhuma escrita foi enviada.`);
  }
  const next = withDimensionMode(restrictions, dimension, mode);
  const update = { resourceName: target.resourceName, targetingSetting: { targetRestrictions: next } };
  let response: Row;
  try {
    // A lista inteira é reenviada: a API apaga as restrições que não vierem
    response = await client.mutate(customerId, level === "campaign" ? "campaigns" : "adGroups", [{ update, updateMask: "targeting_setting.target_restrictions" }]);
  } catch (err) {
    return refuse(`A API recusou — nada foi gravado.\n${explainAudienceError((err as Error).message)}`);
  }
  const effect = mode === "OBSERVATION"
    ? "Observação: os segmentos dessa dimensão não restringem o alcance — só coletam dados e aplicam ajustes de lance."
    : "Segmentação: os segmentos positivos dessa dimensão passam a restringir o alcance a quem está neles.";
  return done(
    (client.isDryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label}: ${dimension} agora em ${MODE_LABEL[mode]}.`) +
    `\n${effect}\n\n${formatJson({
      before: restrictions.map((r) => ({ dimension: r.targetingDimension, bid_only: r.bidOnly })),
      after: next.map((r) => ({ dimension: r.targetingDimension, bid_only: r.bidOnly })),
      scope: level === "campaign" ? "campanha inteira (todos os grupos)" : "somente este grupo",
      update_mask: "targeting_setting.target_restrictions",
      result: response,
    })}`
  );
}

/** Canais com segmentação otimizada (Ajuda do Google Ads 10537509): Display, Vídeo (vendas/leads/tráfego) e Demand Gen. */
const OPTIMIZED_TARGETING_CHANNELS = new Set(["DISPLAY", "VIDEO", "DEMAND_GEN"]);

// ── Listas de remarketing (rule-based e lógicas) ─────────────────────

export const REMARKETING_RULE_TYPES = [
  "URL_CONTAINS", "URL_EQUALS", "URL_STARTS_WITH", "URL_ENDS_WITH", "REFERRER_URL_CONTAINS", "CUSTOM_PARAMETER", "CUSTOM_EVENT",
] as const;
export const RULE_OPERATORS = [
  "CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "NOT_EQUALS", "NOT_CONTAINS", "NOT_STARTS_WITH", "NOT_ENDS_WITH",
  "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL",
] as const;
const STRING_OPERATORS = new Set(["CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "NOT_EQUALS", "NOT_CONTAINS", "NOT_STARTS_WITH", "NOT_ENDS_WITH"]);
const NUMBER_OPERATORS = new Set(["GREATER_THAN", "GREATER_THAN_OR_EQUAL", "EQUALS", "NOT_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUAL"]);
const URL_RULE: Record<string, { name: string; operator: string }> = {
  URL_CONTAINS: { name: "url__", operator: "CONTAINS" },
  URL_EQUALS: { name: "url__", operator: "EQUALS" },
  URL_STARTS_WITH: { name: "url__", operator: "STARTS_WITH" },
  URL_ENDS_WITH: { name: "url__", operator: "ENDS_WITH" },
  REFERRER_URL_CONTAINS: { name: "ref_url__", operator: "CONTAINS" },
};
/** proto UserListRuleItemInfo.name: começa com letra ASCII, _ ou UTF-8 > 127; depois letras, dígitos ou _. */
const RULE_VARIABLE = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/;
/** proto UserListStringRuleItemInfo.value: URL não pode ter quebra de linha, aspas, tab nem parênteses. */
const ILLEGAL_URL_CHARS = /[\n\r\t"'()]/;
export const MAX_MEMBERSHIP_DAYS = 540;

export interface RemarketingRuleInput {
  ruleType: string;
  value: string;
  parameterName?: string;
  operator?: string;
  valueType?: string;
  lookbackDays?: number;
}

function validDays(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MEMBERSHIP_DAYS;
}

/** Uma regra → um FlexibleRuleOperandInfo (com a própria janela), como no guia "visited specific pages". */
export function buildRuleOperand(rule: RemarketingRuleInput, defaultLookback: number): { operand: Row } | { error: string } {
  const value = String(rule?.value ?? "").trim();
  if (!value) return { error: "value vazio" };
  const lookback = rule.lookbackDays ?? defaultLookback;
  if (!validDays(lookback)) return { error: `lookbackDays deve ser inteiro entre 1 e ${MAX_MEMBERSHIP_DAYS} (recebido ${rule.lookbackDays})` };
  let item: Row;
  if (rule.ruleType === "CUSTOM_EVENT") {
    return {
      error: "CUSTOM_EVENT não existe mais: ele gravava o parâmetro ecomm_pagetype, o que não é um evento. " +
        "Use ruleType CUSTOM_PARAMETER com parameterName (o nome do parâmetro que a sua tag envia, ex.: ecomm_pagetype), operator e value",
    };
  }
  if (URL_RULE[rule.ruleType]) {
    if (ILLEGAL_URL_CHARS.test(value)) return { error: `valor de URL com caractere proibido (quebra de linha, aspas, tab ou parênteses): "${value}"` };
    const spec = URL_RULE[rule.ruleType];
    item = { name: spec.name, stringRuleItem: { operator: spec.operator, value } };
  } else if (rule.ruleType === "CUSTOM_PARAMETER") {
    const name = String(rule.parameterName ?? "").trim();
    if (!name) return { error: "CUSTOM_PARAMETER exige parameterName" };
    if (!RULE_VARIABLE.test(name)) return { error: `parameterName inválido: "${name}" (letras, dígitos e _; não pode começar com dígito)` };
    const operator = rule.operator ?? "EQUALS";
    const numeric = rule.valueType === "NUMBER" || (!STRING_OPERATORS.has(operator) && NUMBER_OPERATORS.has(operator));
    if (numeric) {
      if (!NUMBER_OPERATORS.has(operator)) return { error: `operator ${operator} não vale para número` };
      const number = Number(value.replace(",", "."));
      if (!Number.isFinite(number)) return { error: `value "${value}" não é número` };
      item = { name, numberRuleItem: { operator, value: number } };
    } else {
      if (!STRING_OPERATORS.has(operator)) return { error: `operator ${operator} não vale para texto` };
      item = { name, stringRuleItem: { operator, value } };
    }
  } else {
    return { error: `ruleType inválido: ${rule.ruleType}` };
  }
  return { operand: { rule: { ruleItemGroups: [{ ruleItems: [item] }] }, lookbackWindowDays: lookback } };
}

function describeRuleItem(item: Row): string {
  const name = String(item.name ?? "");
  const label = name === "url__" ? "url" : name === "ref_url__" ? "referrer" : name;
  const s = obj(item.stringRuleItem);
  const n = obj(item.numberRuleItem);
  const d = obj(item.dateRuleItem);
  if (s.operator) return `${label} ${s.operator} "${s.value ?? ""}"`;
  if (n.operator) return `${label} ${n.operator} ${n.value ?? ""}`;
  if (d.operator) return `${label} ${d.operator} ${d.value ?? `${d.offsetInDays ?? "?"}d`}`;
  return label;
}

function describeOperand(operand: Row): string {
  const groups = list(obj(operand.rule).ruleItemGroups).map((g) => list(g.ruleItems).map(describeRuleItem).join(" E "));
  const body = groups.length > 1 ? groups.map((g) => `(${g})`).join(" OU ") : groups[0] ?? "?";
  return `${body}${operand.lookbackWindowDays ? ` [${operand.lookbackWindowDays}d]` : ""}`;
}

/** Texto legível do flexible_rule_user_list: inclusivos pelo operador, exclusivos sempre em OU. */
export function describeFlexibleRule(flex: Row): string {
  const joiner = flex.inclusiveRuleOperator === "AND" ? " E " : " OU ";
  const inclusive = list(flex.inclusiveOperands).map((o) => `(${describeOperand(o)})`).join(joiner);
  const exclusive = list(flex.exclusiveOperands).map((o) => `(${describeOperand(o)})`).join(" OU ");
  return exclusive ? `${inclusive || "(todos)"} E NÃO [${exclusive}]` : inclusive;
}

function describeLogicalRules(logical: Row): string {
  return list(logical.rules)
    .map((rule) => `${rule.operator}(${list(rule.ruleOperands).map((o) => lastSegment(o.userList)).join(", ")})`)
    .join(" E ");
}

async function userListNameTaken(client: GoogleAdsClient, customerId: string, name: string, exceptId?: string): Promise<Row | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name FROM user_list WHERE user_list.name = '${gaqlLiteral(name)}'`);
  return rows.map((r) => obj(r.userList)).find((ul) => String(ul.id) !== exceptId);
}

export async function createRemarketingList(
  client: GoogleAdsClient,
  customerId: string,
  args: {
    name: string; description?: string; membershipLifeSpan: number; rules: unknown; ruleOperator?: string;
    excludeRules?: unknown; excludeLifeSpan?: number; prepopulate?: boolean;
  }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const name = String(args.name ?? "").trim();
  if (!name) return refuse("name é obrigatório. Nada foi criado.");
  if (!validDays(args.membershipLifeSpan)) {
    return refuse(`membershipLifeSpan deve ser inteiro entre 1 e ${MAX_MEMBERSHIP_DAYS} (recebido ${args.membershipLifeSpan}). Nada foi criado.`);
  }
  if (args.excludeLifeSpan !== undefined && !validDays(args.excludeLifeSpan)) {
    return refuse(`excludeLifeSpan deve ser inteiro entre 1 e ${MAX_MEMBERSHIP_DAYS} (recebido ${args.excludeLifeSpan}). Nada foi criado.`);
  }
  const operator = args.ruleOperator ?? "OR";
  if (operator !== "AND" && operator !== "OR") return refuse(`ruleOperator deve ser AND ou OR (recebido ${operator}). Nada foi criado.`);
  const rules = (Array.isArray(args.rules) ? args.rules : []) as RemarketingRuleInput[];
  const excludes = (Array.isArray(args.excludeRules) ? args.excludeRules : []) as RemarketingRuleInput[];
  if (!rules.length) return refuse("Informe ao menos uma regra em rules. Nada foi criado.");

  const problems: string[] = [];
  const inclusiveOperands: Row[] = [];
  const exclusiveOperands: Row[] = [];
  rules.forEach((rule, index) => {
    const built = buildRuleOperand(rule, args.membershipLifeSpan);
    if ("error" in built) problems.push(`rules[${index}]: ${built.error}`); else inclusiveOperands.push(built.operand);
  });
  excludes.forEach((rule, index) => {
    const built = buildRuleOperand(rule, args.excludeLifeSpan ?? args.membershipLifeSpan);
    if ("error" in built) problems.push(`excludeRules[${index}]: ${built.error}`); else exclusiveOperands.push(built.operand);
  });
  if (problems.length) return refuse(`Regras inválidas — nada foi criado:\n- ${problems.join("\n- ")}`);

  const clash = await userListNameTaken(client, customerId, name);
  if (clash) return refuse(`Já existe a lista "${clash.name}" (ID ${clash.id}) nesta conta. Nada foi criado.`);

  const flexibleRuleUserList: Row = { inclusiveRuleOperator: operator, inclusiveOperands };
  if (exclusiveOperands.length) flexibleRuleUserList.exclusiveOperands = exclusiveOperands;
  const ruleBasedUserList: Row = { flexibleRuleUserList };
  // REQUESTED inclui quem já visitou (até 30 dias, só Display); sem isso a lista começa vazia
  if (args.prepopulate !== false) ruleBasedUserList.prepopulationStatus = "REQUESTED";
  // membership_life_span é ignorado em listas rule-based: a duração é a janela de cada operando
  const create: Row = { name, membershipStatus: "OPEN", ruleBasedUserList };
  if (args.description?.trim()) create.description = args.description.trim();

  let response: Row;
  try {
    response = await client.mutate(customerId, "userLists", [{ create }]);
  } catch (err) {
    return refuse(`A API recusou a lista — nada foi criado.\n${explainAudienceError((err as Error).message)}`);
  }
  const resourceName = String(mutateResults(response)[0]?.resourceName ?? "");
  const summary = {
    name,
    rule: describeFlexibleRule(flexibleRuleUserList),
    inclusive_operator: operator,
    inclusive_rules: inclusiveOperands.length,
    exclusion_rules: exclusiveOperands.length,
    prepopulation: args.prepopulate !== false ? "REQUESTED (inclui visitantes dos últimos 30 dias, só Display)" : "não solicitada (começa vazia)",
  };
  if (client.isDryRun) return done(`Lista "${name}" — DRY-RUN (validateOnly): validada, nada foi gravado.\n\n${formatJson(summary)}`);
  if (!resourceName) return refuse(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(response)}`);
  return done(
    `Lista de remarketing criada: "${name}"\nResource: ${resourceName}\nID: ${idOfResource(resourceName)}\n` +
    `A duração é a janela de cada regra (lookback); a tag do Google precisa estar no site para a lista crescer.\n\n` +
    formatJson({ ...summary, resource_name: resourceName })
  );
}

export async function createLogicalUserList(
  client: GoogleAdsClient,
  customerId: string,
  args: { name: string; description?: string; rules: Array<{ operator: string; userListIds: unknown }> }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const name = String(args.name ?? "").trim();
  if (!name) return refuse("name é obrigatório. Nada foi criado.");
  const rules = Array.isArray(args.rules) ? args.rules : [];
  if (!rules.length) return refuse("Informe ao menos uma regra em rules ({operator: ALL|ANY|NONE, userListIds}). Nada foi criado.");

  const problems: string[] = [];
  const built: Array<{ operator: string; lists: Array<{ id: string; resourceName: string }> }> = [];
  rules.forEach((rule, index) => {
    if (!["ALL", "ANY", "NONE"].includes(String(rule?.operator))) { problems.push(`rules[${index}]: operator deve ser ALL, ANY ou NONE.`); return; }
    const refs = toStrings(rule.userListIds);
    if (!refs.length) { problems.push(`rules[${index}]: userListIds vazio.`); return; }
    const lists: Array<{ id: string; resourceName: string }> = [];
    for (const ref of refs) {
      const parsed = parseSegmentRef("USER_LIST", ref, cid);
      if ("error" in parsed) problems.push(`rules[${index}]: ${parsed.error}`); else lists.push(parsed);
    }
    built.push({ operator: rule.operator, lists });
  });
  if (problems.length) return refuse(`Pedido inválido — nada foi criado:\n- ${problems.join("\n- ")}`);

  const ids = [...new Set(built.flatMap((r) => r.lists.map((l) => l.id)))];
  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status
     FROM user_list WHERE user_list.id IN (${ids.join(", ")})`);
  const byId = new Map(rows.map((r) => obj(r.userList)).map((ul) => [String(ul.id), ul]));
  for (const id of ids) {
    const ul = byId.get(id);
    if (!ul) { problems.push(`Lista ${id} não existe nesta conta.`); continue; }
    if (ul.type === "LOGICAL") problems.push(`Lista ${id} "${ul.name}" já é lógica — a API não aceita lista lógica dentro de outra.`);
    if (ul.type === "SIMILAR") problems.push(`Lista ${id} "${ul.name}" é SIMILAR (descontinuada) — não pode ser operando.`);
  }
  const types = ids.map((id) => byId.get(id)?.type).filter(Boolean);
  if (types.includes("CRM_BASED") && types.some((t) => t !== "CRM_BASED")) {
    problems.push("A API não aceita misturar listas de Customer Match (CRM_BASED) com outros tipos na mesma lista lógica.");
  }
  if (problems.length) return refuse(`Operandos recusados — nada foi criado:\n- ${problems.join("\n- ")}`);
  const warnings: string[] = [];
  if (built.every((r) => r.operator === "NONE")) warnings.push("Só regras NONE: não há público de partida (ALL/ANY) — a API pode recusar ou a lista ficar vazia.");
  const closed = ids.filter((id) => byId.get(id)?.membershipStatus === "CLOSED");
  if (closed.length) warnings.push(`Listas CLOSED como operando (não crescem mais): ${closed.join(", ")}.`);

  const clash = await userListNameTaken(client, customerId, name);
  if (clash) return refuse(`Já existe a lista "${clash.name}" (ID ${clash.id}) nesta conta. Nada foi criado.`);

  const logicalUserList = {
    rules: built.map((r) => ({ operator: r.operator, ruleOperands: r.lists.map((l) => ({ userList: l.resourceName })) })),
  };
  // membership_life_span também é ignorado em listas lógicas
  const create: Row = { name, membershipStatus: "OPEN", logicalUserList };
  if (args.description?.trim()) create.description = args.description.trim();
  let response: Row;
  try {
    response = await client.mutate(customerId, "userLists", [{ create }]);
  } catch (err) {
    return refuse(`A API recusou a lista — nada foi criado.\n${explainAudienceError((err as Error).message)}`);
  }
  const resourceName = String(mutateResults(response)[0]?.resourceName ?? "");
  const summary = {
    name,
    rule: built.map((r) => `${r.operator}(${r.lists.map((l) => `${l.id} "${byId.get(l.id)?.name ?? ""}"`).join(", ")})`).join(" E "),
    warnings,
  };
  if (client.isDryRun) return done(`Lista lógica "${name}" — DRY-RUN (validateOnly): validada, nada foi gravado.\n\n${formatJson(summary)}`);
  if (!resourceName) return refuse(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(response)}`);
  return done(`Lista lógica criada: "${name}"\nResource: ${resourceName}\nID: ${idOfResource(resourceName)}\n\n${formatJson({ ...summary, resource_name: resourceName })}`);
}

export async function updateRemarketingList(
  client: GoogleAdsClient,
  customerId: string,
  args: { userListId: string; name?: string; description?: string; membershipLifeSpan?: number; status?: string; eligibleForSearch?: boolean; confirm?: boolean }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const id = String(args.userListId ?? "").trim();
  if (!ID.test(id)) return refuse(`userListId deve ser numérico, recebido "${args.userListId}". Nada foi alterado.`);
  if (args.status !== undefined && args.status !== "OPEN" && args.status !== "CLOSED") return refuse(`status deve ser OPEN ou CLOSED (recebido ${args.status}).`);
  if (args.membershipLifeSpan !== undefined && !validDays(args.membershipLifeSpan)) {
    return refuse(`membershipLifeSpan deve ser inteiro entre 1 e ${MAX_MEMBERSHIP_DAYS} (recebido ${args.membershipLifeSpan}). Nada foi alterado.`);
  }
  if (args.name === undefined && args.description === undefined && args.membershipLifeSpan === undefined && args.status === undefined && args.eligibleForSearch === undefined) {
    return refuse("Informe ao menos um ajuste: name, description, membershipLifeSpan, status ou eligibleForSearch. Nada foi alterado.");
  }

  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name, user_list.description, user_list.type, user_list.read_only,
            user_list.membership_status, user_list.membership_life_span, user_list.eligible_for_search,
            user_list.access_reason, user_list.rule_based_user_list.flexible_rule_user_list.inclusive_rule_operator,
            user_list.rule_based_user_list.flexible_rule_user_list.inclusive_operands,
            user_list.rule_based_user_list.flexible_rule_user_list.exclusive_operands
     FROM user_list
     WHERE user_list.id = ${id}`);
  const ul = obj(rows[0]?.userList);
  if (!rows.length || !ul.id) return refuse(`Lista ${id} não encontrada na conta ${cid}. Nada foi alterado.`);
  const label = `Lista ${id} "${ul.name}" (${ul.type})`;
  if (ul.readOnly === true || ul.type === "SIMILAR" || ul.type === "EXTERNAL_REMARKETING") {
    return refuse(`${label} é somente leitura para esta conta (${ul.accessReason ?? "sem acesso de edição"}). Nada foi alterado.`);
  }
  if (args.membershipLifeSpan !== undefined && (ul.type === "RULE_BASED" || ul.type === "LOGICAL")) {
    const flex = obj(obj(ul.ruleBasedUserList).flexibleRuleUserList);
    return refuse(
      `${label}: em listas ${ul.type} a API ignora membership_life_span — a duração é a janela (lookback) de cada regra` +
      `${ul.type === "RULE_BASED" ? ` (hoje: ${describeFlexibleRule(flex) || "sem regras legíveis"})` : ""}. ` +
      `As regras não são editadas por aqui: crie outra lista com create_remarketing_list e a janela desejada. Nada foi alterado.`
    );
  }
  if (args.status === "CLOSED" && ul.membershipStatus !== "CLOSED" && args.confirm !== true) {
    return refuse(`${label}: fechar (CLOSED) para de acumular membros e impede novos alvos positivos. Repita com confirm: true. Nada foi alterado.`);
  }

  const update: Row = { resourceName: `customers/${cid}/userLists/${id}` };
  const mask: string[] = [];
  const changes: Row[] = [];
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) return refuse("name vazio não é aceito. Nada foi alterado.");
    if (name !== ul.name) {
      const clash = await userListNameTaken(client, customerId, name, id);
      if (clash) return refuse(`Já existe a lista "${clash.name}" (ID ${clash.id}). Nada foi alterado.`);
      update.name = name; mask.push("name"); changes.push({ setting: "name", before: ul.name, after: name });
    }
  }
  if (args.description !== undefined) {
    const description = args.description.trim();
    if (!description) return refuse("description vazia é recusada pela API (INVALID_DESCRIPTION). Nada foi alterado.");
    if (description !== String(ul.description ?? "")) {
      update.description = description; mask.push("description"); changes.push({ setting: "description", before: ul.description ?? "", after: description });
    }
  }
  if (args.membershipLifeSpan !== undefined && String(ul.membershipLifeSpan ?? "") !== String(args.membershipLifeSpan)) {
    update.membershipLifeSpan = args.membershipLifeSpan; mask.push("membership_life_span");
    changes.push({ setting: "membership_life_span", before: ul.membershipLifeSpan ?? null, after: args.membershipLifeSpan });
  }
  if (args.status !== undefined && args.status !== ul.membershipStatus) {
    update.membershipStatus = args.status; mask.push("membership_status");
    changes.push({ setting: "membership_status", before: ul.membershipStatus, after: args.status });
  }
  if (args.eligibleForSearch !== undefined && (ul.eligibleForSearch === true) !== args.eligibleForSearch) {
    update.eligibleForSearch = args.eligibleForSearch; mask.push("eligible_for_search");
    changes.push({ setting: "eligible_for_search", before: ul.eligibleForSearch === true, after: args.eligibleForSearch });
  }
  if (!mask.length) return done(`${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`);
  let response: Row;
  try {
    response = await client.mutate(customerId, "userLists", [{ update, updateMask: mask.join(",") }]);
  } catch (err) {
    return refuse(`A API recusou — nada foi gravado.\n${explainAudienceError((err as Error).message)}`);
  }
  return done(
    (client.isDryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label} atualizada.`) +
    `\n\n${formatJson({ changes, update_mask: mask, result: response })}`
  );
}

export const USER_LIST_TYPES = ["REMARKETING", "LOGICAL", "EXTERNAL_REMARKETING", "RULE_BASED", "SIMILAR", "CRM_BASED", "LOOKALIKE"] as const;

export async function listRemarketingLists(
  client: GoogleAdsClient,
  customerId: string,
  args: { query?: string; type?: string; format?: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  if (args.type !== undefined && !(USER_LIST_TYPES as readonly string[]).includes(args.type)) {
    return refuse(`type inválido: ${args.type}. Válidos: ${USER_LIST_TYPES.join(", ")}.`);
  }
  // Sem filtro de status: user_list.status não existe na v25, e filtrar por membership_status
  // esconderia listas CLOSED, que são legítimas e reabríveis.
  const conditions = [
    args.query?.trim() ? `user_list.name LIKE '%${likeLiteral(args.query.trim())}%'` : "",
    args.type ? `user_list.type = '${args.type}'` : "",
  ].filter(Boolean);
  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name, user_list.type, user_list.description,
            user_list.size_for_display, user_list.size_for_search, user_list.size_range_for_display,
            user_list.size_range_for_search, user_list.membership_life_span, user_list.membership_status,
            user_list.eligible_for_display, user_list.eligible_for_search, user_list.read_only,
            user_list.access_reason, user_list.closing_reason, user_list.match_rate_percentage,
            user_list.rule_based_user_list.prepopulation_status,
            user_list.rule_based_user_list.flexible_rule_user_list.inclusive_rule_operator,
            user_list.rule_based_user_list.flexible_rule_user_list.inclusive_operands,
            user_list.rule_based_user_list.flexible_rule_user_list.exclusive_operands,
            user_list.logical_user_list.rules
     FROM user_list
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY user_list.size_for_display DESC`);
  const lists = rows.map((r) => {
    const ul = obj(r.userList);
    const ruleBased = obj(ul.ruleBasedUserList);
    const durationByRule = ul.type === "RULE_BASED" || ul.type === "LOGICAL";
    return {
      id: ul.id,
      name: ul.name,
      type: ul.type,
      size_display: ul.sizeForDisplay ?? null,
      size_search: ul.sizeForSearch ?? null,
      size_range_display: ul.sizeRangeForDisplay ?? null,
      size_range_search: ul.sizeRangeForSearch ?? null,
      // Em rule-based/lógica a API ignora membership_life_span: a duração está nas regras
      membership_days: durationByRule ? null : ul.membershipLifeSpan ?? null,
      membership_status: ul.membershipStatus,
      closing_reason: ul.closingReason ?? null,
      eligible_display: ul.eligibleForDisplay ?? null,
      eligible_search: ul.eligibleForSearch ?? null,
      read_only: ul.readOnly === true,
      access_reason: ul.accessReason ?? null,
      match_rate_pct: ul.type === "CRM_BASED" ? ul.matchRatePercentage ?? null : undefined,
      prepopulation: ul.type === "RULE_BASED" ? ruleBased.prepopulationStatus ?? "NONE" : undefined,
      rule: ul.type === "RULE_BASED" ? describeFlexibleRule(obj(ruleBased.flexibleRuleUserList)) : ul.type === "LOGICAL" ? describeLogicalRules(obj(ul.logicalUserList)) : undefined,
      description: ul.description ?? "",
    };
  });
  if (args.format === "table") return done(formatAsTable(lists as Row[]));
  if (args.format === "csv") return done(formatAsCsv(lists as Row[]));
  return done(`${lists.length} lista(s) de público.\n\n${formatJson(lists)}`);
}

// ── Relatórios de público e demografia ───────────────────────────────

type MetricsView = ReturnType<typeof metricsView>;

const pctDiff = (value: number | null, base: number | null | undefined) =>
  value === null || base === null || base === undefined || base === 0 ? null : round2((value / base - 1) * 100);

/** Sinal para ajuste de lance: compara o CPA do segmento com o da campanha no mesmo período. */
export function performanceSignal(view: MetricsView, base: MetricsView | undefined, minClicks: number, threshold: number): { signal: string; bidDown: boolean; bidUp: boolean } {
  if (view.clicks < minClicks) return { signal: `dados insuficientes (< ${minClicks} cliques)`, bidDown: false, bidUp: false };
  if (!base || base.cpa === null) return { signal: "campanha sem conversões no período — sem base de CPA", bidDown: false, bidUp: false };
  if (view.conversions === 0) {
    return view.spend >= base.cpa
      ? { signal: `gastou ${view.spend} (≥ 1 CPA médio da campanha, ${base.cpa}) sem converter — candidato a reduzir lance ou excluir`, bidDown: true, bidUp: false }
      : { signal: "sem conversões ainda (gasto abaixo de 1 CPA médio)", bidDown: false, bidUp: false };
  }
  const diff = pctDiff(view.cpa, base.cpa) ?? 0;
  if (view.cpa !== null && view.cpa <= base.cpa * (1 - threshold)) return { signal: `CPA ${Math.abs(diff)}% abaixo da campanha — candidato a aumentar lance`, bidDown: false, bidUp: true };
  if (view.cpa !== null && view.cpa >= base.cpa * (1 + threshold)) return { signal: `CPA ${diff}% acima da campanha — candidato a reduzir lance`, bidDown: true, bidUp: false };
  return { signal: "CPA próximo da média da campanha", bidDown: false, bidUp: false };
}

function compareTo(view: MetricsView, base: MetricsView | undefined) {
  return {
    ctr_vs_campaign_pct: pctDiff(view.ctr_pct, base?.ctr_pct),
    cpa_vs_campaign_pct: pctDiff(view.cpa, base?.cpa),
    roas_vs_campaign_pct: pctDiff(view.roas, base?.roas),
  };
}

function reportOutput(rows: Row[], format: string | undefined, header: string, extra: Row): AudienceToolResult {
  if (format === "table") return done(formatAsTable(rows));
  if (format === "csv") return done(formatAsCsv(rows));
  return done(`${header}\n\n${formatJson({ ...extra, rows })}`);
}

function validateReportArgs(args: { campaignId?: string; adGroupId?: string; minClicks?: number; threshold?: number; limit?: number }): string | null {
  if (args.campaignId !== undefined && !ID.test(args.campaignId)) return `campaignId deve ser numérico, recebido "${args.campaignId}".`;
  if (args.adGroupId !== undefined && !ID.test(args.adGroupId)) return `adGroupId deve ser numérico, recebido "${args.adGroupId}".`;
  if (args.minClicks !== undefined && (!Number.isInteger(args.minClicks) || args.minClicks < 0)) return `minClicks deve ser inteiro ≥ 0.`;
  if (args.threshold !== undefined && (!(args.threshold > 0) || args.threshold >= 1)) return `threshold deve estar entre 0 e 1 (0.3 = 30%).`;
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5000)) return `limit deve ser inteiro entre 1 e 5000.`;
  return null;
}

async function campaignTotals(client: GoogleAdsClient, customerId: string, dateClause: string, campaignIds: string[]): Promise<Map<string, MetricsView>> {
  const totals = new Map<string, MetricsView>();
  if (!campaignIds.length) return totals;
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
            metrics.conversions_value
     FROM campaign
     WHERE ${dateClause} AND campaign.id IN (${campaignIds.join(", ")})`);
  const sums = new Map<string, MetricTotals>();
  for (const row of rows) {
    const id = String(obj(row.campaign).id ?? "");
    sums.set(id, addMetrics(sums.get(id) ?? emptyTotals(), obj(row.metrics)));
  }
  for (const [id, sum] of sums) totals.set(id, metricsView(sum));
  return totals;
}

export async function getAudiencePerformance(
  client: GoogleAdsClient,
  customerId: string,
  args: { level?: string; campaignId?: string; adGroupId?: string; dateRange?: { since: string; until: string }; days?: number; format?: string; minClicks?: number; threshold?: number; limit?: number }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const invalid = validateReportArgs(args);
  if (invalid) return refuse(invalid);
  const level = args.level ?? "campaign";
  if (level !== "campaign" && level !== "ad_group") return refuse(`level deve ser campaign ou ad_group (recebido ${level}).`);
  if (level === "campaign" && args.adGroupId) return refuse("adGroupId só vale com level=ad_group.");
  let dateClause: string;
  try { dateClause = buildDateClause(args.dateRange, args.days); } catch (err) { return refuse((err as Error).message); }
  const minClicks = args.minClicks ?? 20;
  const threshold = args.threshold ?? 0.3;
  const filters = [dateClause, args.campaignId ? `campaign.id = ${args.campaignId}` : "", args.adGroupId ? `ad_group.id = ${args.adGroupId}` : ""].filter(Boolean);

  const criterionKey = level === "campaign" ? "campaignCriterion" : "adGroupCriterion";
  const prefix = level === "campaign" ? "campaign_criterion" : "ad_group_criterion";
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
            ${level === "ad_group" ? "ad_group.id, ad_group.name," : ""}
            ${prefix}.criterion_id, ${prefix}.display_name, ${prefix}.type, ${prefix}.negative,
            ${prefix}.bid_modifier, ${prefix}.status,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
     FROM ${level === "campaign" ? "campaign_audience_view" : "ad_group_audience_view"}
     WHERE ${filters.join(" AND ")}`);

  const campaignIds = [...new Set(rows.map((r) => String(obj(r.campaign).id ?? "")).filter((id) => ID.test(id)))];
  const adGroupIds = [...new Set(rows.map((r) => String(obj(r.adGroup).id ?? "")).filter((id) => ID.test(id)))];
  const totals = await campaignTotals(client, customerId, dateClause, campaignIds);

  // Modo efetivo da dimensão AUDIENCE: o setting do grupo (se tiver), senão o da campanha, senão o padrão da API
  const campaignSettings = new Map<string, Restriction[]>();
  const adGroupSettings = new Map<string, Restriction[]>();
  if (campaignIds.length) {
    const settingRows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign.targeting_setting.target_restrictions FROM campaign WHERE campaign.id IN (${campaignIds.join(", ")})`);
    for (const row of settingRows) campaignSettings.set(String(obj(row.campaign).id ?? ""), readRestrictions(obj(row.campaign)));
  }
  if (level === "ad_group" && adGroupIds.length) {
    const settingRows = await client.searchStream(customerId,
      `SELECT ad_group.id, ad_group.targeting_setting.target_restrictions FROM ad_group WHERE ad_group.id IN (${adGroupIds.join(", ")})`);
    for (const row of settingRows) adGroupSettings.set(String(obj(row.adGroup).id ?? ""), readRestrictions(obj(row.adGroup)));
  }
  const modeFor = (campaignId: string, adGroupId?: string) => {
    const own = adGroupId ? adGroupSettings.get(adGroupId) ?? [] : [];
    if (own.length) return { ...modeOf(own), source: "grupo" };
    const camp = campaignSettings.get(campaignId) ?? [];
    if (camp.length) return { ...modeOf(camp), source: "campanha" };
    return { mode: "TARGETING" as const, explicit: false, source: "padrão da API (sem targeting_setting)" };
  };

  const out = rows.map((row) => {
    const campaign = obj(row.campaign);
    const adGroup = obj(row.adGroup);
    const criterion = obj(row[criterionKey]);
    const view = metricsView(addMetrics(emptyTotals(), obj(row.metrics)));
    const base = totals.get(String(campaign.id));
    const negative = criterion.negative === true;
    const mode = modeFor(String(campaign.id), adGroup.id ? String(adGroup.id) : undefined);
    const signal = negative ? { signal: "exclusão", bidDown: false, bidUp: false } : performanceSignal(view, base, minClicks, threshold);
    return {
      campaign_id: campaign.id, campaign: campaign.name, channel: campaign.advertisingChannelType,
      ...(level === "ad_group" ? { ad_group_id: adGroup.id, ad_group: adGroup.name } : {}),
      criterion_id: criterion.criterionId, segment: criterion.displayName, segment_type: criterion.type,
      mode: negative ? "EXCLUSION" : mode.mode, mode_source: negative ? "" : mode.source,
      bid_modifier: criterion.bidModifier ?? null, status: criterion.status,
      ...view,
      ...compareTo(view, base),
      campaign_cpa: base?.cpa ?? null,
      signal: signal.signal,
    };
  }).sort((a, b) => b.spend - a.spend).slice(0, args.limit ?? 200);
  return reportOutput(out as Row[], args.format,
    `${out.length} segmento(s) de público (${level}). CPA/ROAS/CTR comparados à campanha no mesmo período; ` +
    `sinais com ≥ ${minClicks} cliques e limiar de ${Math.round(threshold * 100)}%.`,
    { period: dateClause });
}

const DEMOGRAPHIC_VIEWS = {
  AGE: { view: "age_range_view", field: "age_range", json: "ageRange", criterionType: "AGE_RANGE" },
  GENDER: { view: "gender_view", field: "gender", json: "gender", criterionType: "GENDER" },
  PARENTAL: { view: "parental_status_view", field: "parental_status", json: "parentalStatus", criterionType: "PARENTAL_STATUS" },
  INCOME: { view: "income_range_view", field: "income_range", json: "incomeRange", criterionType: "INCOME_RANGE" },
} as const;
export const DEMOGRAPHIC_DIMENSIONS = Object.keys(DEMOGRAPHIC_VIEWS) as Array<keyof typeof DEMOGRAPHIC_VIEWS>;

export async function getDemographicPerformance(
  client: GoogleAdsClient,
  customerId: string,
  args: { dimension: string; level?: string; campaignId?: string; adGroupId?: string; dateRange?: { since: string; until: string }; days?: number; format?: string; minClicks?: number; threshold?: number }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const invalid = validateReportArgs(args);
  if (invalid) return refuse(invalid);
  const spec = DEMOGRAPHIC_VIEWS[args.dimension as keyof typeof DEMOGRAPHIC_VIEWS];
  if (!spec) return refuse(`dimension inválida: ${args.dimension}. Válidas: ${DEMOGRAPHIC_DIMENSIONS.join(", ")}.`);
  const level = args.level ?? "campaign";
  if (level !== "campaign" && level !== "ad_group") return refuse(`level deve ser campaign ou ad_group (recebido ${level}).`);
  let dateClause: string;
  try { dateClause = buildDateClause(args.dateRange, args.days); } catch (err) { return refuse((err as Error).message); }
  const minClicks = args.minClicks ?? 20;
  const threshold = args.threshold ?? 0.3;
  const idFilters = [args.campaignId ? `campaign.id = ${args.campaignId}` : "", args.adGroupId ? `ad_group.id = ${args.adGroupId}` : ""].filter(Boolean);

  // Idade e gênero ficam em views separadas: a API não cruza os dois numa query
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
            ad_group_criterion.${spec.field}.type, ad_group_criterion.negative, ad_group_criterion.bid_modifier,
            ad_group_criterion.status, metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.conversions_value
     FROM ${spec.view}
     WHERE ${[dateClause, ...idFilters].join(" AND ")}`);

  const campaignIds = new Set(rows.map((r) => String(obj(r.campaign).id ?? "")).filter((id) => ID.test(id)));
  if (args.campaignId) campaignIds.add(args.campaignId);
  // Faixas excluídas não geram métrica: busca as exclusões (grupo e campanha) à parte
  const adGroupExclusions: Row[] = [];
  const campaignExclusions = new Map<string, Set<string>>();
  if (campaignIds.size) {
    const inList = [...campaignIds].join(", ");
    const negRows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
              ad_group_criterion.${spec.field}.type, ad_group_criterion.negative
       FROM ad_group_criterion
       WHERE ad_group_criterion.type = '${spec.criterionType}'
         AND ad_group_criterion.negative = true
         AND ad_group_criterion.status != 'REMOVED'
         AND campaign.id IN (${inList})${args.adGroupId ? ` AND ad_group.id = ${args.adGroupId}` : ""}`);
    adGroupExclusions.push(...negRows);
    const campRows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign_criterion.${spec.field}.type, campaign_criterion.negative
       FROM campaign_criterion
       WHERE campaign_criterion.type = '${spec.criterionType}'
         AND campaign_criterion.negative = true
         AND campaign_criterion.status != 'REMOVED'
         AND campaign.id IN (${inList})`);
    for (const row of campRows) {
      const id = String(obj(row.campaign).id ?? "");
      const bucket = String(obj(obj(row.campaignCriterion)[spec.json]).type ?? "");
      if (!campaignExclusions.has(id)) campaignExclusions.set(id, new Set());
      campaignExclusions.get(id)!.add(bucket);
    }
  }

  interface Bucket { campaignId: string; campaign: string; adGroupId?: string; adGroup?: string; bucket: string; totals: MetricTotals;
    adGroups: Set<string>; excludedIn: Set<string>; modifiers: Set<number> }
  const buckets = new Map<string, Bucket>();
  const campaignSums = new Map<string, MetricTotals>();
  const adGroupsPerCampaign = new Map<string, Set<string>>();
  const touch = (campaign: Row, adGroup: Row, bucketName: string): Bucket => {
    const cId = String(campaign.id ?? "");
    const agId = String(adGroup.id ?? "");
    const key = level === "campaign" ? `${cId}|${bucketName}` : `${agId}|${bucketName}`;
    let b = buckets.get(key);
    if (!b) {
      b = { campaignId: cId, campaign: String(campaign.name ?? ""), bucket: bucketName, totals: emptyTotals(), adGroups: new Set(), excludedIn: new Set(), modifiers: new Set() };
      if (level === "ad_group") { b.adGroupId = agId; b.adGroup = String(adGroup.name ?? ""); }
      buckets.set(key, b);
    }
    b.adGroups.add(agId);
    if (!adGroupsPerCampaign.has(cId)) adGroupsPerCampaign.set(cId, new Set());
    adGroupsPerCampaign.get(cId)!.add(agId);
    return b;
  };
  for (const row of rows) {
    const criterion = obj(row.adGroupCriterion);
    const bucketName = String(obj(criterion[spec.json]).type ?? "");
    const b = touch(obj(row.campaign), obj(row.adGroup), bucketName);
    addMetrics(b.totals, obj(row.metrics));
    const cId = String(obj(row.campaign).id ?? "");
    campaignSums.set(cId, addMetrics(campaignSums.get(cId) ?? emptyTotals(), obj(row.metrics)));
    if (criterion.negative === true) b.excludedIn.add(String(obj(row.adGroup).id ?? ""));
    if (criterion.bidModifier !== undefined) b.modifiers.add(num(criterion.bidModifier));
  }
  for (const row of adGroupExclusions) {
    const bucketName = String(obj(obj(row.adGroupCriterion)[spec.json]).type ?? "");
    const b = touch(obj(row.campaign), obj(row.adGroup), bucketName);
    b.excludedIn.add(String(obj(row.adGroup).id ?? ""));
  }

  const out = [...buckets.values()].map((b) => {
    const view = metricsView(b.totals);
    const baseTotals = campaignSums.get(b.campaignId);
    const base = baseTotals ? metricsView(baseTotals) : undefined;
    const campaignExcluded = campaignExclusions.get(b.campaignId)?.has(b.bucket) === true;
    const excluded = campaignExcluded || (level === "ad_group" ? b.excludedIn.size > 0 : b.excludedIn.size > 0 && b.excludedIn.size >= b.adGroups.size);
    const signal = excluded ? { signal: "faixa excluída", bidDown: false, bidUp: false } : performanceSignal(view, base, minClicks, threshold);
    const share = base && base.spend ? round2((view.spend / base.spend) * 100) : null;
    return {
      campaign_id: b.campaignId, campaign: b.campaign,
      ...(level === "ad_group" ? { ad_group_id: b.adGroupId, ad_group: b.adGroup } : {}),
      bucket: b.bucket,
      excluded,
      excluded_detail: campaignExcluded ? "excluída na campanha" : b.excludedIn.size ? `excluída em ${b.excludedIn.size} de ${level === "ad_group" ? 1 : adGroupsPerCampaign.get(b.campaignId)?.size ?? b.adGroups.size} grupo(s)` : "",
      bid_modifiers: [...b.modifiers],
      ...view,
      spend_share_pct: share,
      ...compareTo(view, base),
      campaign_cpa: base?.cpa ?? null,
      bid_down_candidate: signal.bidDown,
      signal: signal.signal,
    };
  }).sort((a, b) => (String(a.campaign_id).localeCompare(String(b.campaign_id))) || b.spend - a.spend);
  const candidates = out.filter((r) => r.bid_down_candidate).length;
  return reportOutput(out.map((r) => ({ ...r, bid_modifiers: r.bid_modifiers.join(" ") })) as Row[], args.format,
    `${out.length} faixa(s) de ${args.dimension} (${level}). Exclusões: ${out.filter((r) => r.excluded).length}. ` +
    `Candidatas a reduzir lance: ${candidates}. Base de comparação: a própria campanha no período (soma das faixas).`,
    { period: dateClause });
}

// ── Customer Match ────────────────────────────────────────────────────

const CUSTOMER_MATCH_DATA_MANAGER_NOTE =
  "Desde 01/04/2026 o Google recusa uploads de Customer Match pela Google Ads API (OfflineUserDataJobService) para " +
  "projetos do Google Cloud sem uso prévio de Customer Match (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE). Para esses projetos " +
  "o caminho é a Data Manager API (POST https://datamanager.googleapis.com/v1/audienceMembers:ingest, escopo OAuth " +
  "https://www.googleapis.com/auth/datamanager), que este servidor ainda não chama — o token dele só tem o escopo adwords. " +
  "Enquanto isso, suba a lista pela interface do Google Ads (Gerenciador de públicos) ou pela Data Manager API.";

/** Normaliza e-mail como pedem Google Ads e Data Manager: minúsculas, sem espaços; gmail/googlemail sem pontos e sem +sufixo. */
export function normalizeEmail(raw: string): string | null {
  const email = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  const match = /^([^@]+)@([^@]+\.[^@]+)$/.exec(email);
  if (!match) return null;
  let local = match[1];
  const domain = match[2];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

/**
 * Telefone em E.164 (+ e só dígitos). Com + ou 00 na frente, o número já traz o DDI.
 * Sem DDI: com o padrão 55, aceita 10/11 dígitos (DDD + número, zeros de operadora/tronco à esquerda
 * são tirados) ou 12/13 dígitos começando com 55; outros tamanhos são ambíguos e recusados.
 */
export function normalizePhone(raw: string, defaultCountryCode = "55"): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  let digits: string;
  if (trimmed.startsWith("+")) {
    digits = trimmed.slice(1).replace(/\D/g, "");
  } else {
    const d = trimmed.replace(/\D/g, "");
    if (d.startsWith("00")) {
      digits = d.slice(2);
    } else {
      const national = d.replace(/^0+/, "");
      if (defaultCountryCode === "55") {
        if (national.length === 10 || national.length === 11) digits = `55${national}`;
        else if ((national.length === 12 || national.length === 13) && national.startsWith("55")) digits = national;
        else return null;
      } else {
        digits = `${defaultCountryCode}${national}`;
      }
    }
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export interface CustomerMatchMemberInput { email?: string; phone?: string }

/** Normaliza + hasheia; nunca devolve o dado em claro — só índices e motivos. */
export function prepareCustomerMatchMembers(
  input: { members?: CustomerMatchMemberInput[]; emails?: unknown; phones?: unknown },
  defaultCountryCode: string
): { userData: Array<{ identifiers: Row[]; source: string }>; invalid: Array<{ source: string; reason: string }>; duplicates: number; received: number } {
  const entries: Array<{ source: string; email?: string; phone?: string }> = [];
  (input.members ?? []).forEach((m, i) => entries.push({ source: `members[${i}]`, email: m?.email, phone: m?.phone }));
  toStrings(input.emails).forEach((email, i) => entries.push({ source: `emails[${i}]`, email }));
  toStrings(input.phones).forEach((phone, i) => entries.push({ source: `phones[${i}]`, phone }));
  const userData: Array<{ identifiers: Row[]; source: string }> = [];
  const invalid: Array<{ source: string; reason: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const entry of entries) {
    const identifiers: Row[] = [];
    const reasons: string[] = [];
    if (entry.email !== undefined && String(entry.email).trim()) {
      const email = normalizeEmail(entry.email);
      if (email) identifiers.push({ hashedEmail: sha256Hex(email) }); else reasons.push("e-mail inválido");
    }
    if (entry.phone !== undefined && String(entry.phone).trim()) {
      const phone = normalizePhone(entry.phone, defaultCountryCode);
      if (phone) identifiers.push({ hashedPhoneNumber: sha256Hex(phone) }); else reasons.push("telefone fora do E.164 (informe com DDI, ex.: +55 11 91234-5678)");
    }
    if (reasons.length) invalid.push({ source: entry.source, reason: reasons.join("; ") });
    if (!identifiers.length) {
      if (!reasons.length) invalid.push({ source: entry.source, reason: "sem e-mail nem telefone" });
      continue;
    }
    const key = identifiers.map((id) => String(id.hashedEmail ?? id.hashedPhoneNumber)).sort().join("|");
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    userData.push({ identifiers, source: entry.source });
  }
  return { userData, invalid, duplicates, received: entries.length };
}

export function explainCustomerMatchError(message: string): string {
  if (/CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE|not allowlisted|allowlist/i.test(message)) {
    return `${message}\n\n${CUSTOMER_MATCH_DATA_MANAGER_NOTE}`;
  }
  if (/customer data terms|CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS/i.test(message)) {
    return `${message}\nDica: a conta ainda não aceitou os Termos de Dados do Cliente — aceite no Google Ads (Ferramentas › Gerenciador de públicos) e tente de novo.`;
  }
  if (/consent/i.test(message)) return `${message}\nDica: para incluir membros, adUserData e adPersonalization precisam ser GRANTED.`;
  return message;
}

export async function createCustomerMatchList(
  client: GoogleAdsClient,
  customerId: string,
  args: { name: string; description?: string; membershipLifeSpan?: number; uploadKeyType?: string; appId?: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const name = String(args.name ?? "").trim();
  if (!name) return refuse("name é obrigatório. Nada foi criado.");
  const days = args.membershipLifeSpan ?? MAX_MEMBERSHIP_DAYS;
  // Desde 07/04/2025 lista de Customer Match não tem duração infinita: máximo 540 dias
  if (!validDays(days)) return refuse(`membershipLifeSpan deve ser inteiro entre 1 e ${MAX_MEMBERSHIP_DAYS} (Customer Match não aceita mais duração infinita). Nada foi criado.`);
  const keyType = args.uploadKeyType ?? "CONTACT_INFO";
  if (!["CONTACT_INFO", "CRM_ID", "MOBILE_ADVERTISING_ID"].includes(keyType)) return refuse(`uploadKeyType inválido: ${keyType}.`);
  const appId = args.appId?.trim();
  if (keyType === "MOBILE_ADVERTISING_ID" && !appId) return refuse("MOBILE_ADVERTISING_ID exige appId (pacote Android ou ID numérico da App Store). Nada foi criado.");
  if (keyType !== "MOBILE_ADVERTISING_ID" && appId) return refuse("appId só vale com uploadKeyType MOBILE_ADVERTISING_ID. Nada foi criado.");

  const clash = await userListNameTaken(client, customerId, name);
  if (clash) return refuse(`Já existe a lista "${clash.name}" (ID ${clash.id}) nesta conta. Nada foi criado.`);
  const crmBasedUserList: Row = { uploadKeyType: keyType };
  if (appId) crmBasedUserList.appId = appId;
  const create: Row = { name, membershipStatus: "OPEN", membershipLifeSpan: days, crmBasedUserList };
  if (args.description?.trim()) create.description = args.description.trim();
  let response: Row;
  try {
    response = await client.mutate(customerId, "userLists", [{ create }]);
  } catch (err) {
    return refuse(`A API recusou a lista — nada foi criado.\n${explainCustomerMatchError(explainAudienceError((err as Error).message))}`);
  }
  const resourceName = String(mutateResults(response)[0]?.resourceName ?? "");
  const summary = { name, upload_key_type: keyType, membership_days: days };
  if (client.isDryRun) return done(`Lista de Customer Match "${name}" — DRY-RUN (validateOnly): validada, nada foi gravado.\n\n${formatJson(summary)}`);
  if (!resourceName) return refuse(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(response)}`);
  return done(
    `Lista de Customer Match criada (vazia): "${name}"\nResource: ${resourceName}\nID: ${idOfResource(resourceName)}\n\n` +
    `Próximo passo: upload_customer_match_members (o Google recomenda ao menos 5.000 contatos para a lista atingir o mínimo de usuários ativos).\n\n` +
    formatJson({ ...summary, resource_name: resourceName })
  );
}

const MAX_MEMBERS_PER_CALL = 10_000;
/** Guia de Customer Match: até 10.000 identificadores por chamada de addOperations. */
const MAX_IDENTIFIERS_PER_REQUEST = 10_000;

export async function uploadCustomerMatchMembers(
  client: GoogleAdsClient,
  customerId: string,
  args: {
    userListId: string; members?: CustomerMatchMemberInput[]; emails?: unknown; phones?: unknown; mode?: string;
    consent?: { adUserData?: string; adPersonalization?: string }; defaultCountryCode?: string; preview?: boolean; confirm?: boolean;
  }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  const listId = String(args.userListId ?? "").trim();
  if (!ID.test(listId)) return refuse(`userListId deve ser numérico, recebido "${args.userListId}". Nada foi enviado.`);
  const mode = args.mode ?? "add";
  if (!["add", "remove", "replace"].includes(mode)) return refuse(`mode deve ser add, remove ou replace (recebido ${mode}).`);
  const countryCode = String(args.defaultCountryCode ?? "55").replace(/^\+/, "");
  if (!/^[1-9]\d{0,2}$/.test(countryCode)) return refuse(`defaultCountryCode inválido: ${args.defaultCountryCode} (ex.: 55).`);
  const received = (args.members?.length ?? 0) + toStrings(args.emails).length + toStrings(args.phones).length;
  if (received === 0) return refuse("Informe members, emails ou phones. Nada foi enviado.");
  if (received > MAX_MEMBERS_PER_CALL) return refuse(`No máximo ${MAX_MEMBERS_PER_CALL} contatos por chamada (recebidos ${received}). Divida o envio. Nada foi enviado.`);
  if (mode !== "remove") {
    const consent = args.consent ?? {};
    if (consent.adUserData !== "GRANTED" || consent.adPersonalization !== "GRANTED") {
      return refuse(
        "Para incluir membros a API exige consentimento: consent.adUserData e consent.adPersonalization = GRANTED " +
        "(com DENIED a API recusa). Só informe GRANTED se os contatos consentiram (LGPD). Nada foi enviado."
      );
    }
  }
  const prepared = prepareCustomerMatchMembers(args, countryCode);
  const summary: Row = {
    user_list_id: listId, mode, received: prepared.received, valid_members: prepared.userData.length,
    duplicates_removed: prepared.duplicates, invalid: prepared.invalid,
    hashing: "SHA-256 hex após normalização (e-mail em minúsculas; gmail sem pontos/+sufixo; telefone E.164)",
  };
  if (!prepared.userData.length) return refuse(`Nenhum contato válido — nada foi enviado.\n\n${formatJson(summary)}`);
  if ((mode === "replace" || mode === "remove") && args.confirm !== true && args.preview !== true) {
    return refuse(
      `${mode === "replace" ? "replace apaga TODOS os membros atuais da lista antes de incluir os novos" : "remove tira os contatos da lista"} — ` +
      `repita com confirm: true (ou preview: true para só validar). Nada foi enviado.\n\n${formatJson(summary)}`
    );
  }

  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name, user_list.type, user_list.read_only, user_list.membership_status,
            user_list.crm_based_user_list.upload_key_type
     FROM user_list
     WHERE user_list.id = ${listId}`);
  const ul = obj(rows[0]?.userList);
  if (!rows.length || !ul.id) return refuse(`Lista ${listId} não encontrada na conta ${cid}. Nada foi enviado.`);
  const label = `Lista ${listId} "${ul.name}"`;
  if (ul.type !== "CRM_BASED") return refuse(`${label} é ${ul.type}, não Customer Match (CRM_BASED). Crie uma com create_customer_match_list. Nada foi enviado.`);
  if (ul.readOnly === true) return refuse(`${label} é somente leitura para esta conta. Nada foi enviado.`);
  const keyType = obj(ul.crmBasedUserList).uploadKeyType;
  if (keyType !== "CONTACT_INFO") return refuse(`${label} aceita ${keyType}, e esta tool envia e-mail/telefone (CONTACT_INFO). Nada foi enviado.`);
  if (mode !== "remove" && ul.membershipStatus === "CLOSED") return refuse(`${label} está CLOSED — reabra com update_remarketing_list antes de incluir. Nada foi enviado.`);

  if (args.preview === true) return done(`${label} — PREVIEW: validado localmente, nada foi enviado.\n\n${formatJson(summary)}`);
  if (client.isDryRun) {
    return done(
      `${label} — DRY-RUN: nada foi enviado. O upload é um job encadeado (criar → incluir operações → executar) e a ` +
      `API não devolve o ID do job em validate_only; a validação acima foi local.\n\n${formatJson(summary)}`
    );
  }

  const userListResource = `customers/${cid}/userLists/${listId}`;
  const metadata: Row = { userList: userListResource };
  if (mode !== "remove") metadata.consent = { adUserData: "GRANTED", adPersonalization: "GRANTED" };
  let jobResource = "";
  try {
    const created = await client.customerWriteAction<Row>(customerId, "offlineUserDataJobs:create", {
      job: { type: "CUSTOMER_MATCH_USER_LIST", customerMatchUserListMetadata: metadata },
    });
    jobResource = String(created.resourceName ?? "");
  } catch (err) {
    return refuse(`${label}: a API recusou o job — nada foi enviado.\n${explainCustomerMatchError((err as Error).message)}`);
  }
  const jobId = /^customers\/\d+\/offlineUserDataJobs\/(\d+)$/.exec(jobResource)?.[1];
  if (!jobId) return refuse(`${label}: a API não devolveu o job (${jobResource || "vazio"}). Nada foi enviado.`);

  // Operações em lotes de até 10.000 identificadores; remove_all vai sempre primeiro (replace)
  const chunks: Array<{ ops: Row[]; sources: Array<string | null> }> = [];
  let current = { ops: [] as Row[], sources: [] as Array<string | null> };
  let identifiers = 0;
  if (mode === "replace") { current.ops.push({ removeAll: true }); current.sources.push(null); }
  for (const member of prepared.userData) {
    if (identifiers + member.identifiers.length > MAX_IDENTIFIERS_PER_REQUEST) {
      chunks.push(current);
      current = { ops: [], sources: [] };
      identifiers = 0;
    }
    current.ops.push(mode === "remove" ? { remove: { userIdentifiers: member.identifiers } } : { create: { userIdentifiers: member.identifiers } });
    current.sources.push(member.source);
    identifiers += member.identifiers.length;
  }
  if (current.ops.length) chunks.push(current);

  const failed: Array<{ source: string; error: string }> = [];
  const unattributedErrors: string[] = [];
  let sent = 0;
  for (const chunk of chunks) {
    try {
      const response = await client.customerWriteAction<Row>(customerId, `offlineUserDataJobs/${jobId}:addOperations`, {
        enablePartialFailure: true,
        operations: chunk.ops,
      });
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, chunk.ops.length);
      chunk.ops.forEach((_op, index) => {
        const errors = byIndex.get(index);
        const source = chunk.sources[index];
        if (errors) failed.push({ source: source ?? "remove_all", error: errors.join("; ") });
        else if (source) sent++;
      });
      unattributedErrors.push(...unattributed);
    } catch (err) {
      return refuse(
        `${label}: a API recusou as operações do job ${jobResource} — o job NÃO foi executado, nada foi aplicado à lista ` +
        `(o job pendente expira sozinho).\n${explainCustomerMatchError((err as Error).message)}\n\n${formatJson({ ...summary, failed })}`
      );
    }
  }
  if (mode === "replace" && failed.some((f) => f.source === "remove_all")) {
    return refuse(`${label}: a API recusou o remove_all — o job ${jobResource} NÃO foi executado, a lista segue como estava.\n\n${formatJson({ ...summary, failed })}`);
  }
  if (sent === 0) {
    return refuse(`${label}: nenhuma operação aceita — o job ${jobResource} não foi executado.\n\n${formatJson({ ...summary, failed, errors: unattributedErrors })}`);
  }
  let operation: Row;
  try {
    operation = await client.customerWriteAction<Row>(customerId, `offlineUserDataJobs/${jobId}:run`, {});
  } catch (err) {
    return refuse(`${label}: as operações foram aceitas mas o job ${jobResource} não rodou — nada foi aplicado.\n${explainCustomerMatchError((err as Error).message)}`);
  }
  return {
    content: [text(
      `${label}: job ${jobResource} em execução (${mode}). ${sent} contato(s) enviados${failed.length ? `, ${failed.length} recusado(s)` : ""}.\n` +
      `O processamento é assíncrono (pode levar horas): acompanhe com get_customer_match_status.\n\n` +
      formatJson({ ...summary, sent, failed, errors: unattributedErrors, job: jobResource, operation: operation.name ?? null })
    )],
    isError: failed.length > 0 || unattributedErrors.length > 0,
  };
}

export async function getCustomerMatchStatus(
  client: GoogleAdsClient,
  customerId: string,
  args: { userListId?: string; format?: string }
): Promise<AudienceToolResult> {
  const bad = badCustomer(customerId);
  if (bad) return bad;
  const cid = cleanCid(customerId);
  if (args.userListId !== undefined && !ID.test(args.userListId)) return refuse(`userListId deve ser numérico, recebido "${args.userListId}".`);
  const rows = await client.searchStream(customerId,
    `SELECT user_list.id, user_list.name, user_list.membership_status, user_list.membership_life_span,
            user_list.match_rate_percentage, user_list.size_for_search, user_list.size_for_display,
            user_list.size_range_for_search, user_list.size_range_for_display, user_list.eligible_for_search,
            user_list.eligible_for_display, user_list.crm_based_user_list.upload_key_type,
            user_list.crm_based_user_list.data_source_type, user_list.closing_reason, user_list.read_only,
            user_list.access_reason
     FROM user_list
     WHERE user_list.type = 'CRM_BASED'${args.userListId ? ` AND user_list.id = ${args.userListId}` : ""}
     ORDER BY user_list.name`);
  const jobs = new Map<string, Row[]>();
  let jobsNote = "";
  try {
    const jobRows = await client.searchStream(customerId,
      `SELECT offline_user_data_job.id, offline_user_data_job.type, offline_user_data_job.status,
              offline_user_data_job.failure_reason, offline_user_data_job.operation_metadata.match_rate_range,
              offline_user_data_job.customer_match_user_list_metadata.user_list
       FROM offline_user_data_job
       WHERE offline_user_data_job.type = 'CUSTOMER_MATCH_USER_LIST'${args.userListId ? `
         AND offline_user_data_job.customer_match_user_list_metadata.user_list = 'customers/${cid}/userLists/${args.userListId}'` : ""}
       ORDER BY offline_user_data_job.id DESC
       LIMIT 50`);
    for (const row of jobRows) {
      const job = obj(row.offlineUserDataJob);
      const listId = lastSegment(obj(job.customerMatchUserListMetadata).userList);
      if (!jobs.has(listId)) jobs.set(listId, []);
      jobs.get(listId)!.push({
        job_id: job.id, status: job.status, failure_reason: job.failureReason ?? null,
        match_rate_range: obj(job.operationMetadata).matchRateRange ?? null,
      });
    }
  } catch (err) {
    jobsNote = `Não consegui ler os jobs de upload: ${(err as Error).message}`;
  }
  const lists = rows.map((r) => {
    const ul = obj(r.userList);
    const notes: string[] = [];
    if (ul.matchRatePercentage === undefined || ul.matchRatePercentage === null) notes.push("sem taxa de correspondência (nenhum upload processado ainda, ou lista pequena demais)");
    if (ul.membershipStatus === "CLOSED") notes.push(`CLOSED${ul.closingReason ? ` (${ul.closingReason})` : ""}: não acumula membros`);
    if (ul.eligibleForSearch === false) notes.push("não elegível para Pesquisa");
    if (ul.eligibleForDisplay === false) notes.push("não elegível para Display");
    return {
      id: ul.id, name: ul.name, upload_key_type: obj(ul.crmBasedUserList).uploadKeyType ?? null,
      membership_status: ul.membershipStatus, membership_days: ul.membershipLifeSpan ?? null,
      match_rate_pct: ul.matchRatePercentage ?? null,
      size_search: ul.sizeForSearch ?? null, size_range_search: ul.sizeRangeForSearch ?? null,
      size_display: ul.sizeForDisplay ?? null, size_range_display: ul.sizeRangeForDisplay ?? null,
      read_only: ul.readOnly === true, access_reason: ul.accessReason ?? null,
      recent_jobs: jobs.get(String(ul.id)) ?? [],
      notes,
    };
  });
  if (args.format === "table" || args.format === "csv") {
    const flat = lists.map((l) => ({ ...l, recent_jobs: l.recent_jobs.map((j) => `${j.job_id}:${j.status}`).join(" "), notes: l.notes.join("; ") }));
    return done(args.format === "table" ? formatAsTable(flat) : formatAsCsv(flat));
  }
  return done(
    `${lists.length} lista(s) de Customer Match.${jobsNote ? `\n${jobsNote}` : ""}\n\n${formatJson(lists)}\n\n` +
    `Nota: ${CUSTOMER_MATCH_DATA_MANAGER_NOTE}`
  );
}

// ── Registro das tools novas ─────────────────────────────────────────

const segmentSchema = z.object({
  type: z.enum(SEGMENT_TYPES).describe("USER_LIST (remarketing/Customer Match), USER_INTEREST (afinidade/no mercado), CUSTOM_AUDIENCE, COMBINED_AUDIENCE, LIFE_EVENT, AUDIENCE (só grupos Demand Gen/App com use_audience_grouped)."),
  id: z.string().optional().describe("ID numérico do segmento (ver search_audience_segments)."),
  resourceName: z.string().optional().describe("Ou o resource name (customers/{cid}/userLists/{id} etc.)."),
  negative: z.boolean().optional().describe("true = exclusão. Default: false (alvo)."),
  bidModifier: z.number().optional().describe("Ajuste de lance 0.1–10 (1.2 = +20%). Só em alvos. Em segmento já existente, atualiza o ajuste."),
});

export function registerAudiencesTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  mcp.registerTool(
    "search_audience_segments",
    {
      description: [
        "Busca segmentos de público para segmentar ou excluir: AUDIENCE, USER_LIST (remarketing/Customer Match),",
        "AFFINITY e IN_MARKET (interesses do Google), LIFE_EVENT, DETAILED_DEMOGRAPHIC, CUSTOM (personalizados) e COMBINED.",
        "Somente leitura. Devolve targeting_type + id para usar em add_audience_segment_targeting.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        type: z.enum(SEARCH_SEGMENT_TYPES).describe("Tipo de segmento."),
        query: z.string().optional().describe("Trecho do nome (LIKE)."),
        limit: z.number().optional().describe("Máximo de resultados (1–1000). Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, type, query, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return searchAudienceSegments(getClient(), customerId, { type, query, limit, format });
    }
  );

  mcp.registerTool(
    "update_custom_audience",
    {
      description: [
        "Edita um segmento personalizado (custom audience): nome, descrição e membros (keywords, URLs, apps).",
        "WRITE OPERATION — lê o segmento antes, mostra antes/depois e não grava se nada muda.",
        "",
        "membersMode: add (default, acrescenta), remove (tira os informados) ou replace (a lista vira exatamente a informada).",
        "A API substitui a lista inteira no UPDATE; a tool monta a lista final. Membros PLACE_CATEGORY são preservados.",
        "O tipo (AUTO/SEARCH) não pode ser trocado depois de criado (INVALID_TYPE_CHANGE).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        customAudienceId: z.string().describe("ID do segmento personalizado (search_audience_segments type CUSTOM)."),
        name: z.string().optional().describe("Novo nome (único na conta, sem diferenciar maiúsculas)."),
        description: z.string().optional().describe("Nova descrição."),
        membersMode: z.enum(["add", "remove", "replace"]).optional().describe("Como aplicar keywords/urls/apps. Default: add."),
        keywords: flexArray(z.string()).optional().describe("Keywords/frases (até 10 palavras e 80 caracteres cada)."),
        urls: flexArray(z.string()).optional().describe("URLs com http(s):// (até 2048 caracteres)."),
        apps: flexArray(z.string()).optional().describe("Pacotes de apps Android (ex.: com.empresa.app)."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return updateCustomAudience(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "add_audience_segment_targeting",
    {
      description: [
        "Segmenta ou exclui públicos numa campanha ou grupo: remarketing/RLSA, Customer Match, afinidade, no mercado,",
        "segmentos personalizados, combinados, eventos de vida e Audience (Demand Gen/App).",
        "WRITE OPERATION — tudo numa operação atômica (ou grava tudo, ou nada).",
        "",
        "Antes de gravar confere: se os segmentos existem na conta; regras do canal (PMax usa sinais; Audience só em",
        "grupos Demand Gen/App com use_audience_grouped; lista positiva na campanha só em Pesquisa; lista positiva não",
        "pode ficar na campanha e no grupo ao mesmo tempo; SIMILAR e listas CLOSED como alvo são recusadas).",
        "Segmento já existente: nada muda, ou só o bidModifier é atualizado se você passar um diferente.",
        "",
        "Modo (targetingMode) da dimensão AUDIENCE: sem restrição explícita a API usa Segmentação e restringe o alcance.",
        "Em Pesquisa/Shopping o default é Observação quando ainda não há restrição; se já houver segmentos positivos em",
        "Segmentação implícita, a tool pede targetingMode explícito. KEEP não mexe no modo.",
        "Com level=adGroup o modo só é trocado no próprio grupo: se o targeting_setting estiver na campanha (vale para",
        "todos os grupos), a tool recusa a troca — use set_targeting_mode level=campaign ou targetingMode KEEP.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "adGroup"]).describe("Nível do critério."),
        campaignId: z.string().optional().describe("Obrigatório com level=campaign."),
        adGroupId: z.string().optional().describe("Obrigatório com level=adGroup."),
        segments: z.array(segmentSchema).describe("Segmentos (até 50)."),
        targetingMode: z.enum(["OBSERVATION", "TARGETING", "KEEP"]).optional().describe("Modo da dimensão AUDIENCE. Default: Observação em Pesquisa/Shopping sem restrição; KEEP nos demais. Com level=adGroup nunca troca o modo da campanha."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return addAudienceSegmentTargeting(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "remove_audience_segment_targeting",
    {
      description: [
        "Remove critérios de público (alvos ou exclusões) de uma campanha ou grupo.",
        "WRITE OPERATION — exige confirm: true. Sem ele, mostra o que seria removido.",
        "Identifique por criterionIds (get_audience_performance) ou por segments [{type, id}].",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "adGroup"]).describe("Nível do critério."),
        campaignId: z.string().optional().describe("Obrigatório com level=campaign."),
        adGroupId: z.string().optional().describe("Obrigatório com level=adGroup."),
        criterionIds: flexArray(z.string()).optional().describe("IDs dos critérios."),
        segments: z.array(z.object({
          type: z.enum(SEGMENT_TYPES),
          id: z.string().optional(),
          resourceName: z.string().optional(),
        })).optional().describe("Ou os segmentos a remover."),
        confirm: z.boolean().optional().describe("true para remover de fato."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return removeAudienceSegmentTargeting(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "set_targeting_mode",
    {
      description: [
        "Define Observação (bid_only=true: só observa e ajusta lance) ou Segmentação (bid_only=false: restringe o alcance)",
        "para uma dimensão (AUDIENCE por padrão) numa campanha ou grupo.",
        "WRITE OPERATION — lê as restrições atuais, troca só a dimensão pedida e reenvia a lista inteira (a API apaga o que não vier).",
        "A API não aceita targeting_setting na campanha e nos grupos ao mesmo tempo: a tool recusa e diz onde ajustar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "adGroup"]).describe("Nível."),
        campaignId: z.string().optional().describe("Obrigatório com level=campaign."),
        adGroupId: z.string().optional().describe("Obrigatório com level=adGroup."),
        dimension: z.enum(TARGETING_DIMENSIONS).optional().describe("Dimensão. Default: AUDIENCE."),
        mode: z.enum(["OBSERVATION", "TARGETING"]).describe("OBSERVATION ou TARGETING."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return setTargetingMode(getClient(), customerId, args);
    }
  );


  mcp.registerTool(
    "create_logical_user_list",
    {
      description: [
        "Cria uma lista lógica combinando listas existentes: regras {operator ALL|ANY|NONE, userListIds}, todas em E.",
        "Ex.: carrinho abandonado sem compra = [{ANY: [carrinho]}, {NONE: [compradores]}].",
        "WRITE OPERATION — confere as listas (existem, não são lógicas nem SIMILAR, sem misturar Customer Match com outras).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da lista (único na conta)."),
        description: z.string().optional().describe("Descrição."),
        rules: z.array(z.object({
          operator: z.enum(["ALL", "ANY", "NONE"]).describe("ALL = em todas; ANY = em alguma; NONE = em nenhuma."),
          userListIds: flexArray(z.string()).describe("IDs (ou resource names) das listas."),
        })).describe("Regras, combinadas em E."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return createLogicalUserList(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "get_audience_performance",
    {
      description: [
        "Desempenho por segmento de público (remarketing, no mercado, afinidade, personalizados, Customer Match...) por campanha ou grupo.",
        "Somente leitura. Mostra modo (Observação/Segmentação), ajuste de lance, gasto, CTR, CPA e ROAS comparados à",
        "média da campanha, e um sinal para ajuste de lance (com mínimo de cliques).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "ad_group"]).optional().describe("campaign_audience_view ou ad_group_audience_view. Default: campaign."),
        campaignId: z.string().optional().describe("Filtra uma campanha."),
        adGroupId: z.string().optional().describe("Filtra um grupo (level=ad_group)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        minClicks: z.number().optional().describe("Mínimo de cliques para emitir sinal. Default: 20."),
        threshold: z.number().optional().describe("Diferença de CPA para sinalizar (0.3 = 30%). Default: 0.3."),
        limit: z.number().optional().describe("Máximo de linhas (maior gasto primeiro). Default: 200."),
        format: formatSchema,
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return getAudiencePerformance(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "get_demographic_performance",
    {
      description: [
        "Desempenho por faixa demográfica: AGE, GENDER, PARENTAL ou INCOME (uma dimensão por vez — a API não cruza idade × gênero).",
        "Somente leitura. Marca faixas excluídas (no grupo ou na campanha) e candidatas a reduzir lance, comparando o CPA",
        "com a média da campanha no período.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dimension: z.enum(["AGE", "GENDER", "PARENTAL", "INCOME"]).describe("Dimensão demográfica."),
        level: z.enum(["campaign", "ad_group"]).optional().describe("Agrega por campanha ou mostra por grupo. Default: campaign."),
        campaignId: z.string().optional().describe("Filtra uma campanha."),
        adGroupId: z.string().optional().describe("Filtra um grupo."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        minClicks: z.number().optional().describe("Mínimo de cliques para emitir sinal. Default: 20."),
        threshold: z.number().optional().describe("Diferença de CPA para sinalizar (0.3 = 30%). Default: 0.3."),
        format: formatSchema,
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return getDemographicPerformance(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "create_customer_match_list",
    {
      description: [
        "Cria uma lista de Customer Match (CRM) vazia, para receber e-mails/telefones.",
        "WRITE OPERATION. Duração máxima 540 dias (o Google acabou com a duração infinita).",
        "Depois: upload_customer_match_members. Status: get_customer_match_status.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome (único na conta)."),
        description: z.string().optional().describe("Descrição."),
        membershipLifeSpan: z.number().optional().describe("Dias na lista (1–540). Default: 540."),
        uploadKeyType: z.enum(["CONTACT_INFO", "CRM_ID", "MOBILE_ADVERTISING_ID"]).optional().describe("Chave de correspondência. Default: CONTACT_INFO (e-mail/telefone)."),
        appId: z.string().optional().describe("Só com MOBILE_ADVERTISING_ID: pacote Android ou ID da App Store."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return createCustomerMatchList(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "upload_customer_match_members",
    {
      description: [
        "Envia e-mails e telefones para uma lista de Customer Match (CONTACT_INFO). Normaliza (minúsculas, gmail sem",
        "pontos/+sufixo, telefone E.164 com +55 por padrão) e faz o hash SHA-256 aqui no servidor; nada em claro é devolvido.",
        "WRITE OPERATION em passos (job: criar → incluir operações → executar) — validateOnly não se aplica; use preview: true.",
        "mode: add (default), remove ou replace (apaga todos os membros antes) — remove/replace exigem confirm: true.",
        "Incluir exige consent {adUserData, adPersonalization} = GRANTED.",
        "",
        "LIMITE: desde 01/04/2026 o Google recusa este caminho (OfflineUserDataJobService) para projetos sem uso prévio de",
        "Customer Match; nesse caso a tool devolve o erro explicado e o caminho é a Data Manager API (ainda não suportada aqui).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userListId: z.string().describe("ID da lista CRM_BASED (create_customer_match_list)."),
        members: z.array(z.object({
          email: z.string().optional(),
          phone: z.string().optional(),
        })).optional().describe("Contatos (e-mail e/ou telefone da mesma pessoa)."),
        emails: flexArray(z.string()).optional().describe("E-mails avulsos."),
        phones: flexArray(z.string()).optional().describe("Telefones avulsos."),
        mode: z.enum(["add", "remove", "replace"]).optional().describe("Default: add."),
        consent: z.object({
          adUserData: z.enum(["GRANTED", "DENIED"]).optional(),
          adPersonalization: z.enum(["GRANTED", "DENIED"]).optional(),
        }).optional().describe("Consentimento dos contatos (obrigatório GRANTED/GRANTED para incluir)."),
        defaultCountryCode: z.string().optional().describe("DDI para telefones sem +. Default: 55."),
        preview: z.boolean().optional().describe("true = só valida (normalização, lista) sem enviar."),
        confirm: z.boolean().optional().describe("Obrigatório true em remove/replace."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return uploadCustomerMatchMembers(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "get_customer_match_status",
    {
      description: [
        "Status das listas de Customer Match: taxa de correspondência, tamanho (Pesquisa/Display), elegibilidade,",
        "duração e os últimos jobs de upload. Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userListId: z.string().optional().describe("Uma lista só."),
        format: formatSchema,
      },
    },
    async ({ customerId, userListId, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return getCustomerMatchStatus(getClient(), customerId, { userListId, format });
    }
  );
}
