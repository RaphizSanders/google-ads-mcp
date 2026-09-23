/**
 * Lote conversions-offline: importação offline, ajustes de conversão, chamadas e GCLID.
 *
 * Tools:
 * - upload_offline_conversion (movida de tools.ts): UploadClickConversions com
 *   identificadores de usuário (enhanced conversions for leads), consentimento,
 *   cart data, customer type, ambiente, variáveis personalizadas e job_id; mapeia a
 *   restrição de 15/06/2026 (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE).
 * - upload_offline_conversions_data_manager / get_data_manager_request_status:
 *   o mesmo upload pela Data Manager API (events:ingest), para quem caiu na restrição.
 * - upload_conversion_adjustments: retratação, reapresentação de valor e enhancement.
 * - upload_call_conversions: importação de chamadas (UPLOAD_CALLS).
 * - get_conversion_upload_health: diagnóstico das importações (offline_conversion_upload_*_summary).
 * - lookup_gclid: resolve GCLIDs pelo click_view.
 * - get_call_details: chamadas uma a uma pelo call_view.
 *
 * Tudo que é gravado vai para a conta DONA da ação de conversão (a "conversion
 * customer"): é a que a documentação exige para chamadas e ajustes e a única que a
 * Data Manager API aceita. Dados pessoais (e-mail, telefone, nome, endereço) são
 * normalizados e passam por SHA-256 aqui no servidor; nunca voltam em claro na resposta.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  ISO_DATE,
  checkCustomerAccess,
  dateRangeSchema,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  localIsoDate,
  num,
  round2,
  text,
  normalizePhone,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Limites (documentação v25) ───────────────────────────────────────

/** ConversionUploadService e ConversionAdjustmentUploadService: 2.000 por requisição; events:ingest também. */
export const MAX_UPLOAD_ROWS = 2000;
/** ClickConversion / ConversionAdjustment: até 5 user_identifiers. */
export const MAX_ADS_USER_IDENTIFIERS = 5;
/** Data Manager: até 10 userIdentifiers por Event. */
export const MAX_DM_USER_IDENTIFIERS = 10;
/** job_id: inteiro em [1, 2^31) (ConversionUploadError.INVALID_JOB_ID). */
export const MAX_JOB_ID = 2 ** 31 - 1;
/** click_view: um dia por query, até 90 dias para trás. */
export const CLICK_VIEW_MAX_DAYS = 90;
/** Duração padrão de chamada para contar conversão no Google Ads (60 s). */
const DEFAULT_SHORT_CALL_SECONDS = 60;
/** Tolerância para relógio adiantado ao recusar data/hora no futuro. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** RETRACTION/RESTATEMENT: SALESFORCE, UPLOAD_CLICKS ou WEBPAGE; ENHANCEMENT: só WEBPAGE (INVALID_CONVERSION_ACTION_TYPE). */
const ADJUSTABLE_ACTION_TYPES = new Set(["WEBPAGE", "UPLOAD_CLICKS", "SALESFORCE"]);
const ENHANCEMENT_ACTION_TYPE = "WEBPAGE";
/** Guia de enhanced conversions for web: importe o enhancement em até 24 h da conversão original. */
const ENHANCEMENT_WINDOW_MS = 24 * 3_600_000;

// ── Datas ────────────────────────────────────────────────────────────

const ADS_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_TIME_HELP = "use 'yyyy-MM-dd HH:mm:ss+HH:MM' com o fuso (ex.: '2026-09-09 14:30:00-03:00')";

/**
 * Data/hora de relógio com fuso → epoch ms; null se o calendário ou o horário não existem.
 * Date.UTC/Date.parse "rolam" dias inválidos (30/02 vira 02/03), então a conferência é
 * feita aqui: mês 1–12, dia que exista no mês (ida e volta pelo Date.UTC), hora ≤ 23,
 * minuto e segundo ≤ 59 e fuso de até ±14:59.
 */
function wallClockEpoch(
  parts: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  offset: { sign: number; hours: number; minutes: number }
): number | null {
  const { y, mo, d, h, mi, s } = parts;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  if (offset.hours > 14 || offset.minutes > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  const offsetMinutes = (offset.hours * 60 + offset.minutes) * offset.sign;
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
}

/** Data/hora no formato da API ("yyyy-mm-dd hh:mm:ss+|-hh:mm") → epoch ms; null se inválida. */
export function parseAdsDateTime(value: string): number | null {
  const m = ADS_DATE_TIME.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s, oh, om] = [m[1], m[2], m[3], m[4], m[5], m[6], m[8], m[9]].map(Number);
  return wallClockEpoch({ y, mo, d, h, mi, s }, { sign: m[7] === "+" ? 1 : -1, hours: oh, minutes: om });
}

/**
 * RFC 3339 ("2026-09-01T14:30:00-03:00", "…T17:30:00.5Z") → epoch ms; null se inválida.
 * Mesmas regras de calendário de parseAdsDateTime — Date.parse aceitaria 2026-02-30.
 */
export function parseRfc3339(value: string): number | null {
  const m = RFC3339.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const zone = m[8] === "Z" ? null : /^([+-])(\d{2}):(\d{2})$/.exec(m[8]);
  const offset = zone
    ? { sign: zone[1] === "+" ? 1 : -1, hours: Number(zone[2]), minutes: Number(zone[3]) }
    : { sign: 1, hours: 0, minutes: 0 };
  const epoch = wallClockEpoch({ y, mo, d, h, mi, s }, offset);
  if (epoch === null) return null;
  return epoch + (m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0);
}

/** Valida e devolve o epoch; mensagem de erro com o rótulo do campo. */
function checkDateTime(value: unknown, label: string, errors: string[]): number | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} é obrigatório — ${DATE_TIME_HELP}.`);
    return null;
  }
  const ms = parseAdsDateTime(value);
  if (ms === null) {
    errors.push(`${label} inválido ("${value}") — ${DATE_TIME_HELP}.`);
    return null;
  }
  if (ms > Date.now() + FUTURE_TOLERANCE_MS) {
    errors.push(`${label} está no futuro ("${value}").`);
    return null;
  }
  return ms;
}

// ── Normalização e hash de dados do usuário ──────────────────────────

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * E-mail pelas regras de enhanced conversions: sem espaços, minúsculo; em gmail.com e
 * googlemail.com sai todo ponto do usuário e o "+sufixo". Outros domínios mantêm ponto e "+".
 */
export function normalizeEmail(raw: string): { value: string } | { error: string } {
  const compact = raw.replace(/\s+/g, "").toLowerCase();
  const at = compact.indexOf("@");
  const domain = compact.slice(at + 1);
  if (at <= 0 || at !== compact.lastIndexOf("@") || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return { error: "e-mail inválido" };
  }
  let local = compact.slice(0, at);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "").replace(/\+.*$/, "");
    if (!local) return { error: "e-mail inválido" };
  }
  return { value: `${local}@${domain}` };
}

// normalizePhone (E.164 com DDI padrão sem somar o DDI duas vezes) mora em tool-kit.ts:
// Customer Match (audiences) usa a mesma regra.
export { normalizePhone };

/** Nome para hash: minúsculo, sem pontuação, sem espaços nas pontas e com espaço simples no meio. */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/g, " ").trim();
}

/** Endereço (rua e número) para hash: minúsculo, sem espaços nas pontas. */
export function normalizeStreet(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");

interface HashedIdentifiers {
  emails: string[];
  phones: string[];
}

/** E-mail/telefone em claro (normalizados + SHA-256 aqui) ou já com hash (64 hex). */
function collectIdentifiers(
  input: { email?: unknown; phone?: unknown; hashedEmail?: unknown; hashedPhoneNumber?: unknown },
  defaultCountryCode: string | undefined,
  errors: string[]
): HashedIdentifiers {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const raw of list(input.email)) {
    const normalized = normalizeEmail(raw);
    if ("error" in normalized) errors.push(`email: ${normalized.error}`);
    else emails.add(sha256Hex(normalized.value));
  }
  for (const raw of list(input.phone)) {
    const normalized = normalizePhone(raw, defaultCountryCode);
    if ("error" in normalized) errors.push(`phone: ${normalized.error}`);
    else phones.add(sha256Hex(normalized.value));
  }
  for (const hash of list(input.hashedEmail)) {
    if (!SHA256_HEX.test(hash.trim())) errors.push("hashedEmail precisa ser o SHA-256 em hex (64 caracteres) do e-mail normalizado");
    else emails.add(hash.trim().toLowerCase());
  }
  for (const hash of list(input.hashedPhoneNumber)) {
    if (!SHA256_HEX.test(hash.trim())) errors.push("hashedPhoneNumber precisa ser o SHA-256 em hex (64 caracteres) do telefone E.164");
    else phones.add(hash.trim().toLowerCase());
  }
  return { emails: [...emails], phones: [...phones] };
}

interface AddressInput {
  firstName?: string;
  lastName?: string;
  countryCode?: string;
  postalCode?: string;
  street?: string;
  city?: string;
  state?: string;
}

/** Endereço: nome, sobrenome, país e CEP são obrigatórios (os quatro que a API casa juntos). */
function checkAddress(address: AddressInput, errors: string[]): Required<Pick<AddressInput, "firstName" | "lastName" | "countryCode" | "postalCode">> | null {
  const missing = (["firstName", "lastName", "countryCode", "postalCode"] as const).filter((k) => !address[k]?.trim());
  if (missing.length) {
    errors.push(`address incompleto — faltam ${missing.join(", ")} (nome, sobrenome, país e CEP são obrigatórios)`);
    return null;
  }
  const countryCode = address.countryCode!.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    errors.push(`address.countryCode "${address.countryCode}" inválido — use ISO-3166-1 alfa-2 (ex.: BR)`);
    return null;
  }
  const firstName = normalizeName(address.firstName!);
  const lastName = normalizeName(address.lastName!);
  if (!firstName || !lastName) {
    errors.push("address.firstName/lastName ficaram vazios depois da normalização");
    return null;
  }
  return { firstName, lastName, countryCode, postalCode: address.postalCode!.trim() };
}

const adsUserIdentifiers = (ids: HashedIdentifiers): Row[] => [
  ...ids.emails.map((hashedEmail) => ({ userIdentifierSource: "FIRST_PARTY", hashedEmail })),
  ...ids.phones.map((hashedPhoneNumber) => ({ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber })),
];

// ── Erros por linha e dicas ──────────────────────────────────────────

/** Recusa por desenvolvedor sem histórico de upload (restrição de 15/06/2026). */
export const NOT_ALLOWLISTED = /CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE|not allowlisted for (accessing )?this feature/i;

export const RESTRICTION_MESSAGE = [
  "O Google recusou o UploadClickConversions com CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE.",
  "Desde 15/06/2026, o upload de conversões offline pela Google Ads API só continua liberado para credenciais que já",
  "enviavam conversões offline ou enhanced conversions for leads entre 17/12/2025 e 15/06/2026. O Google define a",
  "restrição pelo developer token; como o acesso passou a ser por projeto do Google Cloud, vale para o projeto desta",
  "credencial (inferência a partir do aviso de deprecação — o Google mantém a restrição histórica).",
  "",
  "Caminho indicado pelo Google: Data Manager API → use upload_offline_conversions_data_manager (mesmos dados).",
  "Ela exige: (1) a Data Manager API ativada no projeto do Google Cloud; (2) um token OAuth consentido também com o",
  "escopo https://www.googleapis.com/auth/datamanager (refresh token só com adwords precisa ser gerado de novo;",
  "service account já pede os dois escopos).",
  "Não são afetados: upload_conversion_adjustments (ajustes) e upload_call_conversions (chamadas).",
].join("\n");

/** Dicas em PT-BR para os códigos mais comuns (ConversionUploadError / ConversionAdjustmentUploadError). */
export const ERROR_HINTS: Record<string, string> = {
  CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE: "restrição de 15/06/2026 — use upload_offline_conversions_data_manager",
  TOO_RECENT_EVENT: "clique com menos de 6 h — reenvie depois de 6 h",
  TOO_RECENT_CONVERSION_ACTION: "ação de conversão criada há pouco — espere 6 h (ajustes: 4 a 6 h) e reenvie",
  TOO_RECENT_CALL: "chamada recente demais — espere pelo menos 6 h (o guia de chamadas recomenda 12 h) e reenvie",
  EXPIRED_EVENT: "clique fora da janela de conversão (click-through) da ação — não dá para importar",
  EXPIRED_CALL: "chamada fora da janela de conversão da ação",
  EVENT_NOT_FOUND: "clique não encontrado — confira o GCLID e a data com lookup_gclid; pode não ser de campanha do Google Ads",
  CLICK_NOT_FOUND: "e-mail/telefone sem clique correspondente — em enhanced conversions for leads isso é aviso, não falha de setup",
  CALL_NOT_FOUND: "chamada não encontrada — confira callerId (E.164) e callStartDateTime; exige número de encaminhamento do Google",
  CONVERSION_PRECEDES_EVENT: "conversionDateTime anterior ao clique — corrija a data/fuso",
  CONVERSION_PRECEDES_CALL: "conversionDateTime anterior à chamada",
  ORDER_ID_ALREADY_IN_USE: "orderId já importado — para mudar valor/cancelar use upload_conversion_adjustments",
  DUPLICATE_ORDER_ID: "orderId repetido no mesmo envio",
  CLICK_CONVERSION_ALREADY_EXISTS: "já existe conversão deste clique com o mesmo conversionDateTime — use outro horário ou orderId",
  CALL_CONVERSION_ALREADY_EXISTS: "já existe conversão desta chamada com o mesmo conversionDateTime",
  UNPARSEABLE_GCLID: "GCLID corrompido/truncado — copie o valor inteiro do parâmetro gclid",
  UNPARSEABLE_GBRAID: "gbraid corrompido",
  UNPARSEABLE_WBRAID: "wbraid corrompido",
  UNPARSEABLE_CALLERS_PHONE_NUMBER: "callerId fora do padrão E.164",
  INVALID_CUSTOMER_FOR_CLICK: "o clique é de outra conta — envie para a conta de conversão desse anunciante",
  INVALID_CUSTOMER_FOR_CALL: "a chamada é de outra conta — confira a conta de conversão",
  UNAUTHORIZED_CUSTOMER: "o clique é de uma conta que este login não gerencia",
  CONVERSION_TRACKING_NOT_ENABLED_AT_IMPRESSION_TIME: "a conta não tinha acompanhamento de conversões ativo na hora do clique",
  CONVERSION_TRACKING_NOT_ENABLED_AT_CALL_TIME: "a conta não tinha acompanhamento de conversões ativo na hora da chamada",
  CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS: "aceite os termos de dados do cliente nas configurações de conversão da conta de conversão",
  CUSTOMER_NOT_ENABLED_ENHANCED_CONVERSIONS_FOR_LEADS: "ative enhanced conversions for leads nas configurações de conversão",
  INVALID_USER_IDENTIFIER: "identificador de usuário com hash/normalização errados",
  UNSUPPORTED_USER_IDENTIFIER: "upload de cliques só aceita e-mail e telefone",
  NO_CONVERSION_ACTION_FOUND: "ação inexistente, não ativa ou de outra conta — o envio precisa sair da conta dona da ação",
  INVALID_CONVERSION_ACTION_TYPE: "tipo de ação incompatível com este upload (ajustes: WEBPAGE, UPLOAD_CLICKS ou SALESFORCE; ENHANCEMENT só WEBPAGE)",
  GBRAID_WBRAID_BOTH_SET: "use gbraid OU wbraid, não os dois",
  ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID: "ação com contagem 'uma por clique' não aceita gbraid/wbraid",
  ORDER_ID_CONTAINS_PII: "orderId com dado pessoal (e-mail, telefone) — use um ID de pedido",
  CUSTOM_VARIABLE_NOT_ENABLED: "ative a variável personalizada nas configurações de conversão",
  CUSTOM_VARIABLE_VALUE_CONTAINS_PII: "variável personalizada com dado pessoal",
  CONVERSION_NOT_COMPLIANT_WITH_ATT_POLICY: "sem consentimento de rastreamento (ATT) no iOS",
  CUSTOMER_DATA_POLICY_PROHIBITS_ENHANCED_CONVERSIONS: "a política de dados do Google impede enhanced conversions nesta conta",
  CONVERSION_NOT_FOUND: "conversão original não encontrada — confira orderId (obrigatório em ações WEBPAGE) ou gclid + data/hora exatos",
  CONVERSION_ALREADY_RETRACTED: "conversão já retratada",
  CONVERSION_EXPIRED: "conversão antiga demais para ajuste",
  ADJUSTMENT_PRECEDES_CONVERSION: "adjustmentDateTime anterior à conversão",
  MORE_RECENT_RESTATEMENT_FOUND: "já existe reapresentação mais recente — use um adjustmentDateTime posterior",
  RESTATEMENT_ALREADY_EXISTS: "reapresentação repetida — mande outro adjustmentDateTime (mais recente) para mudar de novo",
  TOO_RECENT_CONVERSION: "conversão recente demais para ajuste — tente mais tarde",
  CANNOT_RESTATE_CONVERSION_ACTION_THAT_ALWAYS_USES_DEFAULT_CONVERSION_VALUE: "a ação sempre usa o valor padrão — não aceita RESTATEMENT",
  MISSING_ORDER_ID_FOR_WEBPAGE: "ação WEBPAGE exige orderId",
  GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET: "use orderId OU gclid + conversionDateTime, não os dois (em ENHANCEMENT, reenvie só com orderId + conversionDateTime, sem gclid)",
  CONVERSION_ALREADY_ENHANCED: "conversão já recebeu enhancement",
  DUPLICATE_ENHANCEMENT_IN_REQUEST: "dois ENHANCEMENT com o mesmo orderId no envio — junte os identificadores numa linha",
  DUPLICATE_ADJUSTMENT_IN_REQUEST: "ajuste repetido para a mesma conversão com o mesmo adjustmentDateTime",
  CONVERSION_ACTION_NOT_ELIGIBLE_FOR_ENHANCEMENT: "ação não elegível para enhancement (enhanced conversions for web desligado?)",
  INVALID_JOB_ID: "jobId fora de [1, 2^31)",
};

interface RowFailure {
  messages: string[];
  codes: string[];
}

/**
 * Distribui o partial_failure_error dos serviços de upload pelas linhas. Diferente dos
 * :mutate (fieldName "operations"), aqui o índice vem em "conversions" ou
 * "conversion_adjustments" — partialFailureByOperation do tool-kit não enxergaria.
 */
export function uploadFailuresByRow(
  partialError: unknown,
  rowCount: number,
  fieldNames: string[]
): { byIndex: Map<number, RowFailure>; unattributed: RowFailure[] } {
  const byIndex = new Map<number, RowFailure>();
  const unattributed: RowFailure[] = [];
  if (!partialError || typeof partialError !== "object") return { byIndex, unattributed };
  const failure = partialError as Row;
  let sawDetail = false;
  for (const detail of (failure.details as Row[]) ?? []) {
    for (const err of (detail.errors as Row[]) ?? []) {
      sawDetail = true;
      const codes = Object.values((err.errorCode as Row) ?? {}).map(String);
      const message = String(err.message ?? "erro sem mensagem");
      const path = ((err.location as Row)?.fieldPathElements as Row[]) ?? [];
      const element = path.find((el) => fieldNames.includes(String(el.fieldName)));
      let index = element && element.index !== undefined ? Number(element.index) : NaN;
      if (Number.isNaN(index) && rowCount === 1) index = 0;
      if (Number.isInteger(index) && index >= 0 && index < rowCount) {
        const entry = byIndex.get(index) ?? { messages: [], codes: [] };
        entry.messages.push(message);
        entry.codes.push(...codes);
        byIndex.set(index, entry);
      } else {
        unattributed.push({ messages: [message], codes });
      }
    }
  }
  if (!sawDetail) unattributed.push({ messages: [String(failure.message ?? formatJson(failure))], codes: [] });
  return { byIndex, unattributed };
}

function describeFailure(failure: RowFailure): string {
  const hints = [...new Set(failure.codes)].map((code) => (ERROR_HINTS[code] ? `${code} → ${ERROR_HINTS[code]}` : code));
  return `${failure.messages.join("; ")}${hints.length ? ` [${hints.join(" | ")}]` : ""}`;
}

// ── Conta de conversão e ação ────────────────────────────────────────

interface CustomerSettings {
  currencyCode?: string;
  timeZone?: string;
  conversionCustomerId?: string;
  acceptedCustomerDataTerms?: boolean;
  enhancedConversionsForLeadsEnabled?: boolean;
}

interface ConversionActionInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  countingType: string;
  alwaysUseDefaultValue: boolean;
  defaultCurrencyCode?: string;
  ownerCustomerId?: string;
}

interface ConversionContext {
  requestedCustomerId: string;
  /** Conta dona da ação (a "conversion customer"): é para ela que o upload vai. */
  uploadCustomerId: string;
  action: ConversionActionInfo;
  requested: CustomerSettings;
  owner: CustomerSettings;
}

const customerIdOf = (resourceName: unknown): string | undefined =>
  /^customers\/(\d+)$/.exec(String(resourceName ?? ""))?.[1];

async function loadCustomerSettings(client: GoogleAdsClient, cid: string): Promise<CustomerSettings> {
  const rows = await client.searchStream(
    cid,
    `SELECT customer.id, customer.currency_code, customer.time_zone,
            customer.conversion_tracking_setting.google_ads_conversion_customer,
            customer.conversion_tracking_setting.accepted_customer_data_terms,
            customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled
     FROM customer
     LIMIT 1`
  );
  const customer = (rows[0]?.customer ?? {}) as Row;
  const setting = (customer.conversionTrackingSetting ?? {}) as Row;
  return {
    currencyCode: customer.currencyCode as string | undefined,
    timeZone: customer.timeZone as string | undefined,
    conversionCustomerId: customerIdOf(setting.googleAdsConversionCustomer),
    acceptedCustomerDataTerms: setting.acceptedCustomerDataTerms as boolean | undefined,
    enhancedConversionsForLeadsEnabled: setting.enhancedConversionsForLeadsEnabled as boolean | undefined,
  };
}

async function fetchConversionAction(client: GoogleAdsClient, cid: string, actionId: string): Promise<ConversionActionInfo | null> {
  const rows = await client.searchStream(
    cid,
    `SELECT conversion_action.id, conversion_action.name, conversion_action.type,
            conversion_action.status, conversion_action.owner_customer,
            conversion_action.counting_type,
            conversion_action.value_settings.always_use_default_value,
            conversion_action.value_settings.default_currency_code
     FROM conversion_action
     WHERE conversion_action.id = ${actionId}`
  );
  const action = rows[0]?.conversionAction as Row | undefined;
  if (!action) return null;
  const valueSettings = (action.valueSettings ?? {}) as Row;
  return {
    id: String(action.id ?? actionId),
    name: String(action.name ?? ""),
    type: String(action.type ?? ""),
    status: String(action.status ?? ""),
    countingType: String(action.countingType ?? ""),
    alwaysUseDefaultValue: valueSettings.alwaysUseDefaultValue === true,
    defaultCurrencyCode: valueSettings.defaultCurrencyCode as string | undefined,
    ownerCustomerId: customerIdOf(action.ownerCustomer),
  };
}

/**
 * Acha a ação na conta pedida ou, com acompanhamento entre contas, na conta de conversão
 * (customer.conversion_tracking_setting.google_ads_conversion_customer). O upload vai para
 * a dona da ação — que também precisa passar pela allowlist.
 */
async function resolveConversionContext(
  ctx: ToolContext,
  client: GoogleAdsClient,
  cid: string,
  actionId: string
): Promise<ConversionContext | { error: string }> {
  const requested = await loadCustomerSettings(client, cid);
  let action = await fetchConversionAction(client, cid, actionId);
  let foundIn = cid;
  const conversionCustomer = requested.conversionCustomerId;
  if (!action && conversionCustomer && conversionCustomer !== cid) {
    const blocked = checkCustomerAccess(conversionCustomer, ctx.allowedCustomerIds, ctx.hosted);
    if (blocked) {
      return {
        error: `A ação ${actionId} não está na conta ${cid}, e a conta de conversão dela (${conversionCustomer}) está fora da allowlist deste servidor. Nada foi enviado.`,
      };
    }
    action = await fetchConversionAction(client, conversionCustomer, actionId);
    foundIn = conversionCustomer;
  }
  if (!action) {
    return {
      error:
        `A ação de conversão ${actionId} não existe na conta ${cid}` +
        (conversionCustomer && conversionCustomer !== cid ? ` nem na conta de conversão ${conversionCustomer}` : "") +
        ". Nada foi enviado. Veja as ações com list_conversion_actions.",
    };
  }
  const owner = action.ownerCustomerId ?? foundIn;
  if (owner !== cid) {
    const blocked = checkCustomerAccess(owner, ctx.allowedCustomerIds, ctx.hosted);
    if (blocked) {
      return {
        error: `A ação ${actionId} pertence à conta ${owner} (conta de conversão), fora da allowlist deste servidor. O upload teria de sair dela — nada foi enviado.`,
      };
    }
  }
  const ownerSettings = owner === cid ? requested : await loadCustomerSettings(client, owner);
  return { requestedCustomerId: cid, uploadCustomerId: owner, action, requested, owner: ownerSettings };
}

function contextLine(context: ConversionContext): string {
  const a = context.action;
  const where =
    context.uploadCustomerId === context.requestedCustomerId
      ? `conta ${context.uploadCustomerId}`
      : `conta de conversão ${context.uploadCustomerId} (dona da ação; conta pedida ${context.requestedCustomerId})`;
  return `Ação "${a.name}" (${a.id}, ${a.type}, ${a.status}) — ${where}.`;
}

// ── Schemas compartilhados ───────────────────────────────────────────

const identifierField = (description: string) =>
  z.union([z.string(), z.array(z.string())]).optional().describe(description);

// Fábrica: instância compartilhada vira "$ref" cruzado no JSON Schema publicado.
const consentSchema = () => z.enum(["GRANTED", "DENIED"]);

const idString = (label: string) => z.string().describe(label);

const phoneCountryCodeField = z.string().optional().describe(
  "DDI para telefones sem '+' (ex.: \"55\"). Número que já traz o DDI sem '+' (ex.: 5511999998888) não ganha o DDI de novo: " +
  "no Brasil (55), nos EUA/Canadá (1) e em Portugal (351) o tamanho decide; nos outros DDIs, número que começa pelo DDI é recusado como ambíguo — use '+'."
);

/** IDs entram na GAQL e nos resource names: só dígitos (customerId aceita os hífens do formato 123-456-7890). */
function checkIds(values: Array<[string, unknown]>): string | null {
  for (const [label, value] of values) {
    if (value === undefined) continue;
    const normalized = typeof value === "string" && label === "customerId" ? value.replace(/-/g, "") : value;
    if (typeof normalized !== "string" || !/^\d+$/.test(normalized)) {
      return `${label} inválido: "${String(value)}" — use só números.`;
    }
  }
  return null;
}

function checkCountryCode(value: string | undefined): { code?: string; error?: string } {
  if (value === undefined) return {};
  const code = value.trim().replace(/^\+/, "");
  if (!/^[1-9]\d{0,2}$/.test(code)) return { error: `defaultPhoneCountryCode inválido: "${value}" — use só o DDI (ex.: "55").` };
  return { code };
}

function checkJobId(jobId: number | undefined): string | null {
  if (jobId === undefined) return null;
  if (!Number.isInteger(jobId) || jobId < 1 || jobId > MAX_JOB_ID) return `jobId inválido: ${jobId} — use um inteiro entre 1 e ${MAX_JOB_ID}.`;
  return null;
}

function checkCurrency(value: string | undefined, label: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    errors.push(`${label} "${value}" inválido — use ISO 4217 (ex.: BRL).`);
    return undefined;
  }
  return code;
}

function checkValue(value: number | undefined, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) errors.push(`${label} precisa ser um número ≥ 0 (recebido ${value}).`);
}

/** orderId com e-mail/telefone vira ORDER_ID_CONTAINS_PII na API. */
function checkOrderId(orderId: string | undefined, errors: string[]): string | undefined {
  if (orderId === undefined) return undefined;
  const value = orderId.trim();
  if (!value) {
    errors.push("orderId vazio.");
    return undefined;
  }
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) {
    errors.push("orderId contém um e-mail — a API recusa dado pessoal no orderId (ORDER_ID_CONTAINS_PII); use o ID do pedido.");
    return undefined;
  }
  return value;
}

const MAX_ERRORS_SHOWN = 40;

function validationFailure(tool: string, errors: string[]): ToolResult {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN);
  return {
    content: [text(
      `${tool}: nada foi enviado — corrija ${errors.length} problema(s):\n- ${shown.join("\n- ")}` +
      (errors.length > shown.length ? `\n… e mais ${errors.length - shown.length}.` : "")
    )],
    isError: true,
  };
}

function checkRowCount(count: number, label: string): string | null {
  if (count === 0) return `Envie ao menos 1 ${label}.`;
  if (count > MAX_UPLOAD_ROWS) return `Máximo de ${MAX_UPLOAD_ROWS} ${label} por envio (recebidas ${count}) — divida em lotes.`;
  return null;
}

/** Relatório por linha de um upload com partial_failure. */
function reportRows(
  rowCount: number,
  describeRow: (index: number) => string,
  result: Row,
  fieldNames: string[],
  dryRun: boolean
): { ok: number; failed: number; lines: string[]; unattributed: string[]; codes: string[] } {
  const { byIndex, unattributed } = uploadFailuresByRow(result.partialFailureError, rowCount, fieldNames);
  const results = (result.results as Row[]) ?? [];
  const lines: string[] = [];
  let ok = 0;
  let failed = 0;
  const codes: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const failure = byIndex.get(i);
    if (failure) {
      failed++;
      codes.push(...failure.codes);
      lines.push(`- linha ${i + 1} (${describeRow(i)}): ${describeFailure(failure)}`);
    } else if (dryRun || (results[i] && Object.keys(results[i]).length > 0)) {
      ok++;
    } else {
      failed++;
      lines.push(`- linha ${i + 1} (${describeRow(i)}): a API não confirmou esta linha`);
    }
  }
  for (const u of unattributed) codes.push(...u.codes);
  return { ok, failed, lines, unattributed: unattributed.map(describeFailure), codes };
}

/** Mascara telefone para relatório: +55119****8888. */
const maskPhone = (e164: string) => (e164.length > 8 ? `${e164.slice(0, 6)}****${e164.slice(-4)}` : "****");

// ── Registro ─────────────────────────────────────────────────────────

export function registerConversionsOfflineTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── upload_offline_conversion ──────────────────────────────────────

  const cartDataSchema = z.object({
    merchantId: z.string().optional().describe("ID do Merchant Center onde estão os produtos."),
    feedCountryCode: z.string().optional().describe("País do feed (ISO-3166-1 alfa-2, ex.: BR)."),
    feedLanguageCode: z.string().optional().describe("Idioma do feed (ISO 639-1, ex.: pt)."),
    localTransactionCost: z.number().optional().describe("Soma dos descontos do carrinho (frete grátis, cupom), na moeda da conversão."),
    items: z.array(z.object({
      productId: z.string().describe("ID do produto no Merchant Center."),
      quantity: z.number().describe("Quantidade vendida (inteiro ≥ 1)."),
      unitPrice: z.number().describe("Preço unitário sem impostos/frete/descontos do pedido."),
    })).optional(),
  });

  mcp.registerTool(
    "upload_offline_conversion",
    {
      description: [
        "Envia conversões offline (importação por clique / enhanced conversions for leads) para uma ação UPLOAD_CLICKS.",
        "WRITE OPERATION.",
        "",
        "Cada conversão precisa de gclid/gbraid/wbraid E/OU identificadores do usuário (email/phone em claro — normalizados",
        "e com hash SHA-256 aqui — ou hashedEmail/hashedPhoneNumber). Linha só com e-mail/telefone = enhanced conversions",
        "for leads (exige termos de dados aceitos e o recurso ligado na conta de conversão). Até 5 identificadores e 2.000",
        "conversões por envio. conversionDateTime com fuso: 'yyyy-MM-dd HH:mm:ss+HH:MM' (ex.: '2026-09-09 14:30:00-03:00').",
        "",
        "adUserDataConsent (GRANTED/DENIED) é fortemente recomendado pelo Google — sem ele a conversão pode não ser atribuída.",
        "O envio sai da conta dona da ação (conta de conversão). A resposta traz o job_id para acompanhar em",
        "get_conversion_upload_health. Se a API responder CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE (restrição de",
        "15/06/2026), use upload_offline_conversions_data_manager. Use validateOnly: true para testar sem gravar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta do anunciante; a conta de conversão é resolvida sozinha)."),
        conversionActionId: idString("ID da ação de conversão (tipo UPLOAD_CLICKS, ativa)."),
        conversions: z.array(z.object({
          gclid: z.string().optional().describe("Google Click ID."),
          gbraid: z.string().optional().describe("Click ID de app iOS (web → app). Não combine com wbraid."),
          wbraid: z.string().optional().describe("Click ID de web iOS (app → web). Não combine com gbraid."),
          conversionDateTime: z.string().describe("Data/hora com fuso: 'yyyy-MM-dd HH:mm:ss+HH:MM'."),
          conversionValue: z.number().optional().describe("Valor da conversão (≥ 0)."),
          currencyCode: z.string().optional().describe("Moeda ISO 4217 (ex.: BRL). Default: moeda padrão da ação ou da conta."),
          orderId: z.string().optional().describe("ID do pedido/lead (evita duplicidade e permite ajustes depois)."),
          email: identifierField("E-mail(s) em claro — normalizados e com SHA-256 no servidor."),
          phone: identifierField("Telefone(s) — viram E.164 e SHA-256 no servidor. Sem '+DDI', use defaultPhoneCountryCode."),
          hashedEmail: identifierField("SHA-256 (hex) do e-mail já normalizado."),
          hashedPhoneNumber: identifierField("SHA-256 (hex) do telefone E.164."),
          adUserDataConsent: consentSchema().optional().describe("Consentimento ad_user_data desta conversão (sobrepõe o padrão)."),
          customerType: z.enum(["NEW", "RETURNING"]).optional().describe("Cliente novo ou recorrente."),
          conversionEnvironment: z.enum(["WEB", "APP"]).optional().describe("Onde a conversão aconteceu."),
          cartData: cartDataSchema.optional().describe("Itens do carrinho (conversões com dados do carrinho)."),
          customVariables: z.array(z.object({
            id: z.string().describe("ID da conversion custom variable."),
            value: z.string().describe("Valor (sem dado pessoal)."),
          })).optional().describe("Variáveis personalizadas (não use com gbraid/wbraid)."),
        })).describe("Conversões a enviar (até 2.000)."),
        adUserDataConsent: consentSchema().optional().describe("Consentimento padrão (ad_user_data) para linhas sem o seu."),
        defaultPhoneCountryCode: phoneCountryCodeField,
        jobId: z.number().optional().describe("job_id opcional (1 a 2^31−1) para agrupar este envio no diagnóstico."),
      },
    },
    async ({ customerId, conversionActionId, conversions, adUserDataConsent, defaultPhoneCountryCode, jobId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["conversionActionId", conversionActionId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const cid = customerId.replace(/-/g, "");
      const tool = "upload_offline_conversion";

      const countError = checkRowCount(conversions.length, "conversões");
      if (countError) return { content: [text(countError)], isError: true };
      const jobError = checkJobId(jobId);
      if (jobError) return { content: [text(jobError)], isError: true };
      const country = checkCountryCode(defaultPhoneCountryCode);
      if (country.error) return { content: [text(country.error)], isError: true };

      // ── validação linha a linha, antes de qualquer chamada ──
      const errors: string[] = [];
      const built: Array<{ row: Row; ids: string; braid: boolean; identifiersOnly: boolean; hasIdentifiers: boolean; needsCurrency: boolean; consent: boolean }> = [];
      const orderIds = new Map<string, number>();
      const clickKeys = new Map<string, number>();
      conversions.forEach((c, i) => {
        const rowErrors: string[] = [];
        const n = i + 1;
        const gclid = c.gclid?.trim();
        const gbraid = c.gbraid?.trim();
        const wbraid = c.wbraid?.trim();
        if (gbraid && wbraid) rowErrors.push("gbraid e wbraid juntos — use só um (GBRAID_WBRAID_BOTH_SET)");
        const ms = checkDateTime(c.conversionDateTime, "conversionDateTime", rowErrors);
        checkValue(c.conversionValue, "conversionValue", rowErrors);
        const currency = checkCurrency(c.currencyCode, "currencyCode", rowErrors);
        const orderId = checkOrderId(c.orderId, rowErrors);
        const identifiers = collectIdentifiers(c, country.code, rowErrors);
        const identifierCount = identifiers.emails.length + identifiers.phones.length;
        if (identifierCount > MAX_ADS_USER_IDENTIFIERS) {
          rowErrors.push(`${identifierCount} identificadores de usuário — o máximo é ${MAX_ADS_USER_IDENTIFIERS}`);
        }
        const clickId = gclid || gbraid || wbraid;
        if (!clickId && identifierCount === 0) {
          rowErrors.push("sem gclid/gbraid/wbraid nem e-mail/telefone — não há como atribuir");
        }
        if ((gbraid || wbraid) && c.customVariables?.length) {
          rowErrors.push("variáveis personalizadas não são aceitas com gbraid/wbraid");
        }
        const customVariables: Row[] = [];
        for (const variable of c.customVariables ?? []) {
          if (!/^\d+$/.test(variable.id)) rowErrors.push(`customVariables.id "${variable.id}" inválido — use o ID numérico`);
          else customVariables.push({ id: variable.id, value: variable.value });
        }
        let cartData: Row | undefined;
        if (c.cartData) {
          const cart = c.cartData;
          cartData = {};
          if (cart.merchantId !== undefined) {
            if (!/^\d+$/.test(cart.merchantId)) rowErrors.push("cartData.merchantId precisa ser numérico");
            else cartData.merchantId = cart.merchantId;
          }
          if (cart.feedCountryCode !== undefined) cartData.feedCountryCode = cart.feedCountryCode.trim().toUpperCase();
          if (cart.feedLanguageCode !== undefined) cartData.feedLanguageCode = cart.feedLanguageCode.trim().toLowerCase();
          if (cart.localTransactionCost !== undefined) {
            checkValue(cart.localTransactionCost, "cartData.localTransactionCost", rowErrors);
            cartData.localTransactionCost = cart.localTransactionCost;
          }
          if (cart.items) {
            cartData.items = cart.items.map((item, j) => {
              if (!item.productId?.trim()) rowErrors.push(`cartData.items[${j}].productId vazio`);
              if (!Number.isInteger(item.quantity) || item.quantity < 1) rowErrors.push(`cartData.items[${j}].quantity precisa ser inteiro ≥ 1`);
              checkValue(item.unitPrice, `cartData.items[${j}].unitPrice`, rowErrors);
              return { productId: item.productId.trim(), quantity: item.quantity, unitPrice: item.unitPrice };
            });
          }
        }
        if (orderId) {
          if (orderIds.has(orderId)) rowErrors.push(`orderId repetido (também na linha ${orderIds.get(orderId)}) — DUPLICATE_ORDER_ID`);
          else orderIds.set(orderId, n);
        }
        if (clickId && ms !== null) {
          const key = `${clickId}|${ms}`;
          if (clickKeys.has(key)) rowErrors.push(`mesmo clique e conversionDateTime da linha ${clickKeys.get(key)} — DUPLICATE_CLICK_CONVERSION_IN_REQUEST`);
          else clickKeys.set(key, n);
        }
        if (rowErrors.length) {
          errors.push(...rowErrors.map((e) => `linha ${n}: ${e}`));
          return;
        }
        const row: Row = { conversionDateTime: c.conversionDateTime.trim() };
        if (gclid) row.gclid = gclid;
        if (gbraid) row.gbraid = gbraid;
        if (wbraid) row.wbraid = wbraid;
        if (c.conversionValue !== undefined) row.conversionValue = c.conversionValue;
        if (currency) row.currencyCode = currency;
        if (orderId) row.orderId = orderId;
        const userIdentifiers = adsUserIdentifiers(identifiers);
        if (userIdentifiers.length) row.userIdentifiers = userIdentifiers;
        const consent = c.adUserDataConsent ?? adUserDataConsent;
        if (consent) row.consent = { adUserData: consent };
        if (c.customerType) row.customerType = c.customerType;
        if (c.conversionEnvironment) row.conversionEnvironment = c.conversionEnvironment;
        if (cartData && Object.keys(cartData).length) row.cartData = cartData;
        if (customVariables.length) row.customVariables = customVariables;
        const idParts = [gclid ? "gclid" : "", gbraid ? "gbraid" : "", wbraid ? "wbraid" : "",
          identifiers.emails.length ? "email#" : "", identifiers.phones.length ? "telefone#" : ""].filter(Boolean);
        built.push({
          row,
          ids: `${idParts.join("+")}${orderId ? `, pedido ${orderId}` : ""}`,
          braid: Boolean(gbraid || wbraid),
          identifiersOnly: !clickId,
          hasIdentifiers: identifierCount > 0,
          needsCurrency: c.conversionValue !== undefined && !currency,
          consent: Boolean(consent),
        });
      });
      if (errors.length) return validationFailure(tool, errors);

      // ── leitura: conta de conversão, ação e pré-requisitos ──
      const client = getClient();
      const context = await resolveConversionContext(ctx, client, cid, conversionActionId);
      if ("error" in context) return { content: [text(context.error)], isError: true };
      const action = context.action;
      if (action.type !== "UPLOAD_CLICKS") {
        return {
          content: [text(`${contextLine(context)}\nUpload de cliques exige uma ação UPLOAD_CLICKS (esta é ${action.type}). Nada foi enviado. ` +
            (action.type === "UPLOAD_CALLS" ? "Para chamadas, use upload_call_conversions." : "Crie uma com create_conversion_action type=UPLOAD."))],
          isError: true,
        };
      }
      if (action.status !== "ENABLED") {
        return {
          content: [text(`${contextLine(context)}\nA ação não está ativa (${action.status}) — a API recusaria (NO_CONVERSION_ACTION_FOUND). Nada foi enviado.`)],
          isError: true,
        };
      }
      const preErrors: string[] = [];
      if (action.countingType === "ONE_PER_CLICK") {
        built.forEach((b, i) => {
          if (b.braid) preErrors.push(`linha ${i + 1}: a ação conta "uma por clique" e não aceita gbraid/wbraid (ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID)`);
        });
      }
      const identifierOnlyRows = built.filter((b) => b.identifiersOnly).length;
      const terms = context.owner.acceptedCustomerDataTerms;
      const ecl = context.owner.enhancedConversionsForLeadsEnabled;
      if (identifierOnlyRows > 0 && (terms === false || ecl === false)) {
        preErrors.push(
          `${identifierOnlyRows} linha(s) só com e-mail/telefone (enhanced conversions for leads), mas a conta de conversão ` +
          `${context.uploadCustomerId} está com ${[terms === false ? "termos de dados do cliente NÃO aceitos" : "", ecl === false ? "enhanced conversions for leads DESLIGADO" : ""].filter(Boolean).join(" e ")}. ` +
          "Ajuste nas configurações de conversão da conta ou mande o gclid."
        );
      }
      if (preErrors.length) return validationFailure(tool, [contextLine(context), ...preErrors]);

      const warnings: string[] = [];
      const withoutConsent = built.filter((b) => !b.consent).length;
      if (withoutConsent) warnings.push(`${withoutConsent} linha(s) sem adUserDataConsent — o Google recomenda enviar; sem ele a conversão pode não ser atribuída.`);
      const withIdentifiers = built.filter((b) => b.hasIdentifiers && !b.identifiersOnly).length;
      if (withIdentifiers && (terms === false || ecl === false)) {
        warnings.push(`${withIdentifiers} linha(s) com e-mail/telefone, mas os pré-requisitos de enhanced conversions for leads não estão completos na conta ${context.uploadCustomerId} — os identificadores podem ser recusados.`);
      }
      if (action.alwaysUseDefaultValue && built.some((b) => b.row.conversionValue !== undefined)) {
        warnings.push("A ação usa sempre o valor padrão — o conversionValue enviado não deve ser considerado.");
      }

      const defaultCurrency = action.defaultCurrencyCode || context.requested.currencyCode || context.owner.currencyCode;
      for (const b of built) {
        if (b.needsCurrency && defaultCurrency) b.row.currencyCode = defaultCurrency;
      }
      const conversionAction = `customers/${context.uploadCustomerId}/conversionActions/${action.id}`;
      const payload = built.map((b) => {
        const row: Row = { conversionAction, ...b.row };
        if (Array.isArray(row.customVariables)) {
          row.customVariables = (row.customVariables as Row[]).map((v) => ({
            conversionCustomVariable: `customers/${context.uploadCustomerId}/conversionCustomVariables/${v.id}`,
            value: v.value,
          }));
        }
        return row;
      });

      let result: Row;
      try {
        result = await client.customerWriteAction<Row>(context.uploadCustomerId, ":uploadClickConversions", {
          conversions: payload,
          partialFailure: true,
          ...(jobId !== undefined ? { jobId } : {}),
        });
      } catch (err) {
        const message = (err as Error).message;
        if (NOT_ALLOWLISTED.test(message)) {
          return { content: [text(`${RESTRICTION_MESSAGE}\n\nNada foi gravado. Detalhe da API: ${message}`)], isError: true };
        }
        return { content: [text(`${contextLine(context)}\nA API recusou o envio inteiro — nada foi gravado.\n${message}`)], isError: true };
      }

      const dryRun = client.isDryRun;
      const report = reportRows(payload.length, (i) => built[i].ids, result, ["conversions"], dryRun);
      if (report.codes.includes("CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE") && report.ok === 0) {
        return { content: [text(`${RESTRICTION_MESSAGE}\n\nNada foi gravado.`)], isError: true };
      }
      const header = dryRun
        ? `DRY-RUN (validateOnly): ${payload.length} conversão(ões) validada(s), nada gravado — ${report.ok} válida(s), ${report.failed} com erro.`
        : `Upload de ${payload.length} conversão(ões) de clique — ${report.ok} aceita(s), ${report.failed} recusada(s).` +
          (result.jobId !== undefined ? ` job_id: ${String(result.jobId)}.` : "");
      const body = [
        header,
        contextLine(context),
        ...(report.failed && report.ok ? ["ATENÇÃO: envio parcial — só as linhas abaixo falharam."] : []),
        ...(warnings.length ? ["Avisos:", ...warnings.map((w) => `- ${w}`)] : []),
        ...(report.lines.length ? ["Linhas com erro:", ...report.lines] : []),
        ...(report.unattributed.length ? ["Erros sem linha:", ...report.unattributed.map((u) => `- ${u}`)] : []),
        ...(!dryRun && report.ok ? ["As conversões aparecem no relatório pela data do clique e podem levar horas. Acompanhe em get_conversion_upload_health."] : []),
      ];
      return { content: [text(body.join("\n"))], isError: report.ok === 0 };
    }
  );

  // ── upload_offline_conversions_data_manager ────────────────────────

  mcp.registerTool(
    "upload_offline_conversions_data_manager",
    {
      description: [
        "Envia conversões offline pela Data Manager API (events:ingest) — o caminho que o Google indica depois da",
        "restrição de 15/06/2026 no UploadClickConversions (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE).",
        "WRITE OPERATION.",
        "",
        "Pré-requisitos: Data Manager API ativada no projeto do Google Cloud e token OAuth consentido também com o escopo",
        "https://www.googleapis.com/auth/datamanager (refresh token só com adwords precisa ser gerado de novo; service account",
        "já pede os dois escopos).",
        "Mesmos dados de upload_offline_conversion: gclid/gbraid/wbraid e/ou e-mail/telefone/endereço (hash SHA-256 aqui),",
        "consentimento, valor, moeda, orderId (vira transactionId — reenviar o mesmo orderId com outro valor vira ajuste),",
        "carrinho e variáveis. Até 2.000 eventos e 10 identificadores por evento. O destino é a conta DONA da ação",
        "(conta de conversão), exigência da Data Manager API.",
        "Modelo fast-fail: um erro recusa o envio inteiro. A resposta traz o requestId — acompanhe com",
        "get_data_manager_request_status. Não há retratação pela Data Manager API: use upload_conversion_adjustments.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta de conversão é resolvida sozinha)."),
        conversionActionId: idString("ID da ação de conversão (UPLOAD_CLICKS, ativa)."),
        conversions: z.array(z.object({
          gclid: z.string().optional().describe("Google Click ID."),
          gbraid: z.string().optional().describe("Click ID iOS (web → app)."),
          wbraid: z.string().optional().describe("Click ID iOS (app → web)."),
          conversionDateTime: z.string().describe("Data/hora com fuso: 'yyyy-MM-dd HH:mm:ss+HH:MM' (ou RFC 3339)."),
          conversionValue: z.number().optional().describe("Valor (≥ 0)."),
          currencyCode: z.string().optional().describe("Moeda ISO 4217. Default: moeda padrão da ação ou da conta."),
          orderId: z.string().optional().describe("ID do pedido/lead (transactionId)."),
          email: identifierField("E-mail(s) em claro — hash SHA-256 no servidor."),
          phone: identifierField("Telefone(s) — E.164 + SHA-256 no servidor."),
          hashedEmail: identifierField("SHA-256 (hex) do e-mail normalizado."),
          hashedPhoneNumber: identifierField("SHA-256 (hex) do telefone E.164."),
          address: z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            countryCode: z.string().optional().describe("ISO-3166-1 alfa-2 (ex.: BR)."),
            postalCode: z.string().optional(),
          }).optional().describe("Nome, sobrenome, país e CEP (os quatro obrigatórios; nome/sobrenome com hash)."),
          adUserDataConsent: consentSchema().optional().describe("Consentimento ad_user_data deste evento."),
          customerType: z.enum(["NEW", "RETURNING", "REENGAGED"]).optional(),
          cartData: z.object({
            merchantId: z.string().optional(),
            feedLabel: z.string().optional().describe("Feed label (ou país, ex.: BR)."),
            feedLanguageCode: z.string().optional(),
            transactionDiscount: z.number().optional(),
            items: z.array(z.object({
              productId: z.string(),
              quantity: z.number(),
              unitPrice: z.number(),
            })).optional(),
          }).optional(),
          customVariables: z.array(z.object({
            name: z.string().describe("NOME da variável personalizada (a Data Manager usa o nome, não o ID)."),
            value: z.string(),
          })).optional(),
        })).describe("Conversões (até 2.000)."),
        adUserDataConsent: consentSchema().optional().describe("Consentimento padrão (nível da requisição)."),
        defaultPhoneCountryCode: phoneCountryCodeField,
        eventSource: z.enum(["WEB", "APP", "IN_STORE", "PHONE", "MESSAGE", "OTHER"]).optional().describe("Origem dos eventos."),
      },
    },
    async ({ customerId, conversionActionId, conversions, adUserDataConsent, defaultPhoneCountryCode, eventSource }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["conversionActionId", conversionActionId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const cid = customerId.replace(/-/g, "");
      const tool = "upload_offline_conversions_data_manager";
      const countError = checkRowCount(conversions.length, "conversões");
      if (countError) return { content: [text(countError)], isError: true };
      const country = checkCountryCode(defaultPhoneCountryCode);
      if (country.error) return { content: [text(country.error)], isError: true };

      const errors: string[] = [];
      const events: Array<{ event: Row; needsCurrency: boolean }> = [];
      const orderIds = new Map<string, number>();
      conversions.forEach((c, i) => {
        const rowErrors: string[] = [];
        const n = i + 1;
        const gclid = c.gclid?.trim();
        const gbraid = c.gbraid?.trim();
        const wbraid = c.wbraid?.trim();
        if (gbraid && wbraid) rowErrors.push("gbraid e wbraid juntos — use só um");
        let eventTimestamp: string | undefined;
        const rawTime = c.conversionDateTime?.trim() ?? "";
        if (RFC3339.test(rawTime)) {
          // Data Manager é fast-fail: uma data impossível (30/02) recusaria os 2.000 eventos.
          const ms = parseRfc3339(rawTime);
          if (ms === null) rowErrors.push(`conversionDateTime inválido ("${rawTime}") — data ou horário inexistente`);
          else if (ms > Date.now() + FUTURE_TOLERANCE_MS) rowErrors.push(`conversionDateTime está no futuro ("${rawTime}")`);
          else eventTimestamp = rawTime;
        } else if (checkDateTime(rawTime, "conversionDateTime", rowErrors) !== null) {
          eventTimestamp = rawTime.replace(" ", "T");
        }
        checkValue(c.conversionValue, "conversionValue", rowErrors);
        const currency = checkCurrency(c.currencyCode, "currencyCode", rowErrors);
        const orderId = checkOrderId(c.orderId, rowErrors);
        const identifiers = collectIdentifiers(c, country.code, rowErrors);
        const userIdentifiers: Row[] = [
          ...identifiers.emails.map((emailAddress) => ({ emailAddress })),
          ...identifiers.phones.map((phoneNumber) => ({ phoneNumber })),
        ];
        if (c.address) {
          const address = checkAddress(c.address, rowErrors);
          if (address) {
            userIdentifiers.push({
              address: {
                givenName: sha256Hex(address.firstName),
                familyName: sha256Hex(address.lastName),
                regionCode: address.countryCode,
                postalCode: address.postalCode,
              },
            });
          }
        }
        if (userIdentifiers.length > MAX_DM_USER_IDENTIFIERS) {
          rowErrors.push(`${userIdentifiers.length} identificadores — o máximo é ${MAX_DM_USER_IDENTIFIERS} por evento`);
        }
        if (!gclid && !gbraid && !wbraid && userIdentifiers.length === 0) {
          rowErrors.push("sem gclid/gbraid/wbraid nem dados do usuário — não há como atribuir");
        }
        if (orderId) {
          if (orderIds.has(orderId)) rowErrors.push(`orderId repetido (também na linha ${orderIds.get(orderId)})`);
          else orderIds.set(orderId, n);
        }
        let cartData: Row | undefined;
        if (c.cartData) {
          const cart = c.cartData;
          cartData = {};
          if (cart.merchantId !== undefined) {
            if (!/^\d+$/.test(cart.merchantId)) rowErrors.push("cartData.merchantId precisa ser numérico");
            else cartData.merchantId = cart.merchantId;
          }
          if (cart.feedLabel !== undefined) cartData.merchantFeedLabel = cart.feedLabel.trim();
          if (cart.feedLanguageCode !== undefined) cartData.merchantFeedLanguageCode = cart.feedLanguageCode.trim().toLowerCase();
          if (cart.transactionDiscount !== undefined) {
            checkValue(cart.transactionDiscount, "cartData.transactionDiscount", rowErrors);
            cartData.transactionDiscount = cart.transactionDiscount;
          }
          if (cart.items) {
            cartData.items = cart.items.map((item, j) => {
              if (!item.productId?.trim()) rowErrors.push(`cartData.items[${j}].productId vazio`);
              if (!Number.isInteger(item.quantity) || item.quantity < 1) rowErrors.push(`cartData.items[${j}].quantity precisa ser inteiro ≥ 1`);
              checkValue(item.unitPrice, `cartData.items[${j}].unitPrice`, rowErrors);
              return { merchantProductId: item.productId.trim(), quantity: String(item.quantity), unitPrice: item.unitPrice };
            });
          }
        }
        for (const variable of c.customVariables ?? []) {
          if (!variable.name?.trim()) rowErrors.push("customVariables.name vazio");
        }
        if (rowErrors.length) {
          errors.push(...rowErrors.map((e) => `linha ${n}: ${e}`));
          return;
        }
        const event: Row = { eventTimestamp };
        const adIdentifiers: Row = {};
        if (gclid) adIdentifiers.gclid = gclid;
        if (gbraid) adIdentifiers.gbraid = gbraid;
        if (wbraid) adIdentifiers.wbraid = wbraid;
        if (Object.keys(adIdentifiers).length) event.adIdentifiers = adIdentifiers;
        if (userIdentifiers.length) event.userData = { userIdentifiers };
        if (orderId) event.transactionId = orderId;
        if (c.conversionValue !== undefined) event.conversionValue = c.conversionValue;
        if (currency) event.currency = currency;
        if (c.adUserDataConsent) event.consent = { adUserData: `CONSENT_${c.adUserDataConsent}` };
        if (c.customerType) event.userProperties = { customerType: c.customerType };
        if (eventSource) event.eventSource = eventSource;
        if (cartData && Object.keys(cartData).length) event.cartData = cartData;
        if (c.customVariables?.length) event.customVariables = c.customVariables.map((v) => ({ variable: v.name.trim(), value: v.value }));
        events.push({ event, needsCurrency: c.conversionValue !== undefined && !currency });
      });
      if (errors.length) return validationFailure(tool, errors);

      const client = getClient();
      const context = await resolveConversionContext(ctx, client, cid, conversionActionId);
      if ("error" in context) return { content: [text(context.error)], isError: true };
      const action = context.action;
      if (action.type !== "UPLOAD_CLICKS" || action.status !== "ENABLED") {
        return {
          content: [text(`${contextLine(context)}\nA Data Manager API importa conversões offline para ações UPLOAD_CLICKS ativas (esta é ${action.type}, ${action.status}). Nada foi enviado.`)],
          isError: true,
        };
      }
      const defaultCurrency = action.defaultCurrencyCode || context.requested.currencyCode || context.owner.currencyCode;
      for (const e of events) if (e.needsCurrency && defaultCurrency) e.event.currency = defaultCurrency;

      const body: Row = {
        destinations: [{
          operatingAccount: { accountType: "GOOGLE_ADS", accountId: context.uploadCustomerId },
          productDestinationId: action.id,
        }],
        events: events.map((e) => e.event),
        encoding: "HEX",
        ...(adUserDataConsent ? { consent: { adUserData: `CONSENT_${adUserDataConsent}` } } : {}),
      };

      let result: Row;
      try {
        result = await client.dataManagerIngestEvents(body);
      } catch (err) {
        return { content: [text(`${contextLine(context)}\n${explainDataManagerError((err as Error).message, client.authMode)}`)], isError: true };
      }
      const dryRun = client.isDryRun;
      const warnings = ((result.fieldWarnings as Row[]) ?? []).map((w) => `- ${formatJson(w).replace(/\s+/g, " ")}`);
      const lines = [
        dryRun
          ? `DRY-RUN (validateOnly): ${events.length} evento(s) validado(s) pela Data Manager API — nada foi gravado.`
          : `Data Manager API: ${events.length} evento(s) recebido(s). requestId: ${String(result.requestId ?? "(não informado)")}.`,
        contextLine(context),
        `Destino: operatingAccount ${context.uploadCustomerId}, productDestinationId ${action.id}.`,
        ...(warnings.length ? ["Avisos por campo:", ...warnings] : []),
        ...(!dryRun && result.requestId
          ? [`O processamento é assíncrono: confira com get_data_manager_request_status (customerId ${context.uploadCustomerId}, requestId ${String(result.requestId)}).`]
          : []),
      ];
      return { content: [text(lines.join("\n"))] };
    }
  );

  // ── get_data_manager_request_status ────────────────────────────────

  mcp.registerTool(
    "get_data_manager_request_status",
    {
      description: [
        "Status de um envio feito por upload_offline_conversions_data_manager (Data Manager requestStatus:retrieve).",
        "READ OPERATION.",
        "",
        "Mostra por destino: SUCCESS, PROCESSING, PARTIAL_SUCCESS ou FAILED, a contagem de eventos e os motivos de erro",
        "e aviso com quantidades. Exige o mesmo token com escopo datamanager. Destinos de contas fora da allowlist são ocultados.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Conta para a qual o envio foi feito (a conta de conversão)."),
        requestId: z.string().describe("requestId devolvido por upload_offline_conversions_data_manager."),
      },
    },
    async ({ customerId, requestId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const id = requestId.trim();
      if (!/^[A-Za-z0-9._:~-]{1,200}$/.test(id)) {
        return { content: [text(`requestId inválido: "${requestId}".`)], isError: true };
      }
      const client = getClient();
      let result: Row;
      try {
        result = await client.dataManagerRequestStatus(id);
      } catch (err) {
        return { content: [text(explainDataManagerError((err as Error).message, client.authMode))], isError: true };
      }
      const destinations = (result.requestStatusPerDestination as Row[]) ?? [];
      const visible: Row[] = [];
      let hidden = 0;
      for (const d of destinations) {
        const account = String(((d.destination as Row)?.operatingAccount as Row)?.accountId ?? "");
        if (!account || checkCustomerAccess(account, allowedCustomerIds, hosted)) {
          hidden++;
          continue;
        }
        const errorsInfo = (((d.errorInfo as Row)?.errorCounts as Row[]) ?? []).map((e) => ({ reason: e.reason, records: num(e.recordCount) }));
        const warningsInfo = (((d.warningInfo as Row)?.warningCounts as Row[]) ?? []).map((e) => ({ reason: e.reason, records: num(e.recordCount) }));
        visible.push({
          operating_account: account,
          product_destination_id: (d.destination as Row)?.productDestinationId,
          status: d.requestStatus,
          status_label: DM_STATUS_LABELS[String(d.requestStatus)] ?? String(d.requestStatus ?? ""),
          events: num((d.eventsIngestionStatus as Row)?.recordCount),
          errors: errorsInfo,
          warnings: warningsInfo,
        });
      }
      if (visible.length === 0) {
        return {
          content: [text(`Nenhum destino visível para o requestId ${id}` + (hidden ? ` (${hidden} fora da allowlist).` : "."))],
          isError: destinations.length === 0 ? false : true,
        };
      }
      return {
        content: [text(
          `requestId ${id}: ${visible.length} destino(s).` + (hidden ? ` ${hidden} destino(s) ocultado(s) — fora da allowlist.` : "") +
          `\n\n${formatJson(visible)}`
        )],
      };
    }
  );

  // ── upload_conversion_adjustments ──────────────────────────────────

  mcp.registerTool(
    "upload_conversion_adjustments",
    {
      description: [
        "Ajusta conversões já registradas: RETRACTION (zera — pedido cancelado, estornado, boleto/Pix não pago),",
        "RESTATEMENT (novo valor — devolução parcial) ou ENHANCEMENT (acrescenta e-mail/telefone/endereço com hash).",
        "WRITE OPERATION. Único caminho de retratação: a Data Manager API não retrata.",
        "",
        "RETRACTION/RESTATEMENT: ações WEBPAGE, UPLOAD_CLICKS ou SALESFORCE (em WEBPAGE o orderId é obrigatório);",
        "identifique a conversão por orderId OU gclid + conversionDateTime (não os dois).",
        "ENHANCEMENT: só ações WEBPAGE; exige orderId e ao menos um identificador; conversionDateTime da conversão",
        "original é opcional e recomendado (vai sem gclid); gclid opcional junto do orderId; um enhancement por orderId",
        "por envio; importe em até 24 h da conversão.",
        "RESTATEMENT exige adjustedValue; RETRACTION não aceita valor. adjustmentDateTime com fuso e posterior à conversão.",
        "Até 2.000 ajustes por envio. Ação recém-criada: espere 4 a 6 h. O envio sai da conta dona da ação.",
        "Retratação não se desfaz: exige confirm: true (validateOnly: true valida sem confirm e sem gravar).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta dona da ação é resolvida sozinha)."),
        conversionActionId: idString("ID da ação de conversão (WEBPAGE, UPLOAD_CLICKS ou SALESFORCE; ENHANCEMENT só WEBPAGE)."),
        adjustments: z.array(z.object({
          type: z.enum(["RETRACTION", "RESTATEMENT", "ENHANCEMENT"]).describe("Tipo do ajuste."),
          orderId: z.string().optional().describe("ID do pedido da conversão original (obrigatório em WEBPAGE e em ENHANCEMENT)."),
          gclid: z.string().optional().describe("GCLID da conversão original: em RETRACTION/RESTATEMENT, no lugar do orderId; em ENHANCEMENT, opcional junto do orderId."),
          conversionDateTime: z.string().optional().describe("Data/hora EXATA da conversão original, com fuso. RETRACTION/RESTATEMENT: só com gclid. ENHANCEMENT: recomendada, com ou sem gclid."),
          adjustmentDateTime: z.string().describe("Quando o ajuste aconteceu: 'yyyy-MM-dd HH:mm:ss+HH:MM'."),
          adjustedValue: z.number().optional().describe("RESTATEMENT: valor novo TOTAL da conversão (ex.: 100 → 70 manda 70)."),
          currencyCode: z.string().optional().describe("RESTATEMENT: moeda (default: a da ação ou da conta)."),
          email: identifierField("ENHANCEMENT: e-mail(s) em claro (hash no servidor)."),
          phone: identifierField("ENHANCEMENT: telefone(s) (E.164 + hash no servidor)."),
          hashedEmail: identifierField("ENHANCEMENT: SHA-256 (hex) do e-mail normalizado."),
          hashedPhoneNumber: identifierField("ENHANCEMENT: SHA-256 (hex) do telefone E.164."),
          address: z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            street: z.string().optional().describe("Rua e número (vai com hash)."),
            city: z.string().optional(),
            state: z.string().optional(),
            countryCode: z.string().optional().describe("ISO-3166-1 alfa-2 (ex.: BR)."),
            postalCode: z.string().optional(),
          }).optional().describe("ENHANCEMENT: endereço (nome, sobrenome, país e CEP obrigatórios)."),
          userAgent: z.string().optional().describe("ENHANCEMENT: user agent da conversão original."),
        })).describe("Ajustes (até 2.000)."),
        defaultPhoneCountryCode: phoneCountryCodeField,
        jobId: z.number().optional().describe("job_id opcional (1 a 2^31−1) para o diagnóstico."),
        confirm: z.boolean().optional().describe("Obrigatório (true) quando houver RETRACTION e o envio for real."),
      },
    },
    async ({ customerId, conversionActionId, adjustments, defaultPhoneCountryCode, jobId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["conversionActionId", conversionActionId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const cid = customerId.replace(/-/g, "");
      const tool = "upload_conversion_adjustments";
      const countError = checkRowCount(adjustments.length, "ajustes");
      if (countError) return { content: [text(countError)], isError: true };
      const jobError = checkJobId(jobId);
      if (jobError) return { content: [text(jobError)], isError: true };
      const country = checkCountryCode(defaultPhoneCountryCode);
      if (country.error) return { content: [text(country.error)], isError: true };

      const errors: string[] = [];
      const built: Array<{ row: Row; label: string; type: string; byGclid: boolean }> = [];
      const keys = new Map<string, number>();
      let staleEnhancements = 0;
      adjustments.forEach((a, i) => {
        const rowErrors: string[] = [];
        const n = i + 1;
        const orderId = checkOrderId(a.orderId, rowErrors);
        const gclid = a.gclid?.trim();
        const conversionDateTime = a.conversionDateTime?.trim();
        const adjustedMs = checkDateTime(a.adjustmentDateTime, "adjustmentDateTime", rowErrors);
        let conversionMs: number | null = null;
        if (gclid || conversionDateTime) {
          conversionMs = checkDateTime(a.conversionDateTime, "conversionDateTime", rowErrors);
        }
        if (a.type === "ENHANCEMENT") {
          // Enhancement casa pelo orderId. conversionDateTime é opcional e recomendado (vai em
          // gclidDateTimePair.conversionDateTime); o gclid é opcional e vai junto do orderId —
          // o proto v25 permite ("may be set in addition to the order_id") e o guia recomenda.
          if (!orderId) rowErrors.push("ENHANCEMENT exige orderId (o enhancement casa pelo pedido; gclid + conversionDateTime sozinhos não bastam)");
        } else if (orderId && (gclid || conversionDateTime)) {
          rowErrors.push(
            `${a.type}: use orderId OU gclid + conversionDateTime, não os dois (GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET)` +
            (gclid ? "" : " — com orderId, tire o conversionDateTime")
          );
        } else if (!orderId && !gclid) {
          rowErrors.push(
            conversionDateTime
              ? `${a.type}: conversionDateTime sem gclid — identifique por orderId ou pelo par gclid + conversionDateTime`
              : "identifique a conversão por orderId ou por gclid + conversionDateTime"
          );
        }
        if (adjustedMs !== null && conversionMs !== null && adjustedMs < conversionMs) {
          rowErrors.push("adjustmentDateTime anterior à conversão (ADJUSTMENT_PRECEDES_CONVERSION)");
        }
        if (a.type === "RESTATEMENT") {
          if (a.adjustedValue === undefined) rowErrors.push("RESTATEMENT exige adjustedValue (o valor novo total)");
          checkValue(a.adjustedValue, "adjustedValue", rowErrors);
        } else {
          if (a.adjustedValue !== undefined) rowErrors.push(`${a.type} não aceita adjustedValue (só RESTATEMENT)`);
          if (a.currencyCode !== undefined) rowErrors.push(`${a.type} não aceita currencyCode (só RESTATEMENT)`);
        }
        const currency = a.type === "RESTATEMENT" ? checkCurrency(a.currencyCode, "currencyCode", rowErrors) : undefined;
        const identifiers = collectIdentifiers(a, country.code, rowErrors);
        const userIdentifiers = adsUserIdentifiers(identifiers);
        if (a.address) {
          const address = checkAddress(a.address, rowErrors);
          if (address) {
            const info: Row = {
              hashedFirstName: sha256Hex(address.firstName),
              hashedLastName: sha256Hex(address.lastName),
              countryCode: address.countryCode,
              postalCode: address.postalCode,
            };
            if (a.address.street?.trim()) info.hashedStreetAddress = sha256Hex(normalizeStreet(a.address.street));
            if (a.address.city?.trim()) info.city = a.address.city.trim();
            if (a.address.state?.trim()) info.state = a.address.state.trim();
            userIdentifiers.push({ userIdentifierSource: "FIRST_PARTY", addressInfo: info });
          }
        }
        if (a.type === "ENHANCEMENT") {
          if (userIdentifiers.length === 0) rowErrors.push("ENHANCEMENT exige e-mail, telefone ou endereço");
          if (userIdentifiers.length > MAX_ADS_USER_IDENTIFIERS) rowErrors.push(`${userIdentifiers.length} identificadores — o máximo é ${MAX_ADS_USER_IDENTIFIERS}`);
        } else {
          if (userIdentifiers.length || a.address) rowErrors.push(`${a.type} não aceita identificadores de usuário (só ENHANCEMENT)`);
          if (a.userAgent) rowErrors.push(`${a.type} não aceita userAgent (só ENHANCEMENT)`);
        }
        // DUPLICATE_ENHANCEMENT_IN_REQUEST: mesma ação + mesmo orderId, qualquer que seja o horário.
        // DUPLICATE_ADJUSTMENT_IN_REQUEST: mesma conversão com o mesmo adjustment_date_time.
        const key = a.type === "ENHANCEMENT"
          ? `ENHANCEMENT|${orderId}`
          : `${a.type}|${orderId ?? `${gclid}|${conversionMs}`}|${adjustedMs}`;
        if (rowErrors.length === 0) {
          if (keys.has(key)) {
            rowErrors.push(a.type === "ENHANCEMENT"
              ? `ENHANCEMENT repetido para o pedido ${orderId} (também na linha ${keys.get(key)}) — um enhancement por orderId por envio (DUPLICATE_ENHANCEMENT_IN_REQUEST); junte os identificadores numa linha só`
              : `ajuste repetido (igual à linha ${keys.get(key)}) — DUPLICATE_ADJUSTMENT_IN_REQUEST`);
          } else keys.set(key, n);
        }
        if (rowErrors.length) {
          errors.push(...rowErrors.map((e) => `linha ${n}: ${e}`));
          return;
        }
        const row: Row = { adjustmentType: a.type, adjustmentDateTime: a.adjustmentDateTime.trim() };
        if (orderId) row.orderId = orderId;
        if (gclid) row.gclidDateTimePair = { gclid, conversionDateTime };
        else if (a.type === "ENHANCEMENT" && conversionDateTime) row.gclidDateTimePair = { conversionDateTime };
        if (a.type === "ENHANCEMENT" && conversionMs !== null && Date.now() - conversionMs > ENHANCEMENT_WINDOW_MS) staleEnhancements++;
        if (a.type === "RESTATEMENT") row.restatementValue = { adjustedValue: a.adjustedValue, ...(currency ? { currencyCode: currency } : {}) };
        if (userIdentifiers.length) row.userIdentifiers = userIdentifiers;
        if (a.userAgent?.trim()) row.userAgent = a.userAgent.trim();
        built.push({ row, label: `${a.type} ${orderId ? `pedido ${orderId}` : "gclid"}`, type: a.type, byGclid: !orderId });
      });
      if (errors.length) return validationFailure(tool, errors);

      const client = getClient();
      const retractions = built.filter((b) => b.type === "RETRACTION").length;
      if (retractions && confirm !== true && !client.isDryRun) {
        return {
          content: [text(
            `${retractions} RETRACTION(s): a retratação zera a conversão e não se desfaz. Nada foi enviado. ` +
            "Confira (validateOnly: true valida sem gravar) e reenvie com confirm: true."
          )],
          isError: true,
        };
      }
      const context = await resolveConversionContext(ctx, client, cid, conversionActionId);
      if ("error" in context) return { content: [text(context.error)], isError: true };
      const action = context.action;
      const preErrors: string[] = [];
      if (!ADJUSTABLE_ACTION_TYPES.has(action.type)) {
        preErrors.push(`ajustes só valem para ações WEBPAGE, UPLOAD_CLICKS ou SALESFORCE (esta é ${action.type}) — INVALID_CONVERSION_ACTION_TYPE`);
      } else if (action.type !== ENHANCEMENT_ACTION_TYPE) {
        built.forEach((b, i) => {
          if (b.type === "ENHANCEMENT") {
            preErrors.push(`linha ${i + 1}: ENHANCEMENT só vale para ações WEBPAGE (esta é ${action.type}) — INVALID_CONVERSION_ACTION_TYPE; para ${action.type} use RETRACTION/RESTATEMENT` +
              (action.type === "UPLOAD_CLICKS" ? " ou mande os identificadores na própria conversão (upload_offline_conversion)" : ""));
          }
        });
      }
      if (action.status === "REMOVED") preErrors.push("a ação está REMOVED");
      if (action.type === "WEBPAGE") {
        built.forEach((b, i) => {
          if (b.byGclid) preErrors.push(`linha ${i + 1}: ação WEBPAGE exige orderId (MISSING_ORDER_ID_FOR_WEBPAGE)`);
        });
      }
      if (action.alwaysUseDefaultValue) {
        built.forEach((b, i) => {
          if (b.type === "RESTATEMENT") preErrors.push(`linha ${i + 1}: a ação usa sempre o valor padrão e não aceita RESTATEMENT`);
        });
      }
      if (preErrors.length) return validationFailure(tool, [contextLine(context), ...preErrors]);

      const conversionAction = `customers/${context.uploadCustomerId}/conversionActions/${action.id}`;
      const payload = built.map((b) => ({ conversionAction, ...b.row }));
      let result: Row;
      try {
        result = await client.customerWriteAction<Row>(context.uploadCustomerId, ":uploadConversionAdjustments", {
          conversionAdjustments: payload,
          partialFailure: true,
          ...(jobId !== undefined ? { jobId } : {}),
        });
      } catch (err) {
        return { content: [text(`${contextLine(context)}\nA API recusou o envio inteiro — nada foi gravado.\n${(err as Error).message}`)], isError: true };
      }
      const dryRun = client.isDryRun;
      const report = reportRows(payload.length, (i) => built[i].label, result, ["conversion_adjustments", "conversionAdjustments"], dryRun);
      const counts = ["RETRACTION", "RESTATEMENT", "ENHANCEMENT"]
        .map((t) => [t, built.filter((b) => b.type === t).length] as const)
        .filter(([, count]) => count > 0)
        .map(([t, count]) => `${count} ${t}`)
        .join(", ");
      const header = dryRun
        ? `DRY-RUN (validateOnly): ${payload.length} ajuste(s) validado(s) (${counts}), nada gravado — ${report.ok} válido(s), ${report.failed} com erro.`
        : `Ajustes enviados (${counts}) — ${report.ok} aceito(s), ${report.failed} recusado(s).` +
          (result.jobId !== undefined ? ` job_id: ${String(result.jobId)}.` : "");
      const warnings: string[] = [];
      if (action.status === "HIDDEN") warnings.push("a ação está HIDDEN.");
      if (staleEnhancements) {
        warnings.push(`${staleEnhancements} ENHANCEMENT(s) com conversionDateTime há mais de 24 h — o guia do Google pede o enhancement em até 24 h da conversão original.`);
      }
      const lines = [
        header,
        contextLine(context),
        ...(report.failed && report.ok ? ["ATENÇÃO: envio parcial — só as linhas abaixo falharam."] : []),
        ...(warnings.length ? ["Avisos:", ...warnings.map((w) => `- ${w}`)] : []),
        ...(report.lines.length ? ["Linhas com erro:", ...report.lines] : []),
        ...(report.unattributed.length ? ["Erros sem linha:", ...report.unattributed.map((u) => `- ${u}`)] : []),
        ...(!dryRun && report.ok ? ["Os ajustes refletem nos relatórios pela data da conversão original e podem levar horas."] : []),
      ];
      return { content: [text(lines.join("\n"))], isError: report.ok === 0 };
    }
  );

  // ── upload_call_conversions ────────────────────────────────────────

  mcp.registerTool(
    "upload_call_conversions",
    {
      description: [
        "Importa conversões de chamadas (qualificadas no CRM/call center) para uma ação UPLOAD_CALLS.",
        "WRITE OPERATION.",
        "",
        "Cada chamada: callerId (E.164, ex.: +5511999998888 — ou use defaultPhoneCountryCode), callStartDateTime e",
        "conversionDateTime com fuso ('yyyy-MM-dd HH:mm:ss+HH:MM'; a conversão não pode ser anterior à chamada),",
        "valor ≥ 0 opcional e consentimento ad_user_data (obrigatório pelo guia: por linha ou adUserDataConsent padrão).",
        "Só funciona para chamadas com número de encaminhamento do Google. TOO_RECENT_CALL: espere (6 a 12 h) e",
        "reenvie. Até 2.000 por envio; o envio sai da conta de conversão. Use validateOnly: true para testar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta de conversão é resolvida sozinha)."),
        conversionActionId: idString("ID da ação de conversão (UPLOAD_CALLS, ativa)."),
        calls: z.array(z.object({
          callerId: z.string().describe("Telefone de quem ligou, E.164 (+5511999998888)."),
          callStartDateTime: z.string().describe("Início da chamada, com fuso."),
          conversionDateTime: z.string().describe("Quando virou conversão, com fuso (≥ início da chamada)."),
          conversionValue: z.number().optional().describe("Valor (≥ 0)."),
          currencyCode: z.string().optional().describe("Moeda ISO 4217. Default: moeda padrão da ação ou da conta."),
          adUserDataConsent: consentSchema().optional().describe("Consentimento ad_user_data desta chamada."),
          customVariables: z.array(z.object({
            id: z.string().describe("ID da conversion custom variable."),
            value: z.string(),
          })).optional(),
        })).describe("Chamadas (até 2.000)."),
        adUserDataConsent: consentSchema().optional().describe("Consentimento padrão para linhas sem o seu."),
        defaultPhoneCountryCode: phoneCountryCodeField,
      },
    },
    async ({ customerId, conversionActionId, calls, adUserDataConsent, defaultPhoneCountryCode }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["conversionActionId", conversionActionId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const cid = customerId.replace(/-/g, "");
      const tool = "upload_call_conversions";
      const countError = checkRowCount(calls.length, "chamadas");
      if (countError) return { content: [text(countError)], isError: true };
      const country = checkCountryCode(defaultPhoneCountryCode);
      if (country.error) return { content: [text(country.error)], isError: true };

      const errors: string[] = [];
      const built: Array<{ row: Row; label: string; needsCurrency: boolean }> = [];
      const keys = new Map<string, number>();
      calls.forEach((c, i) => {
        const rowErrors: string[] = [];
        const n = i + 1;
        const phone = normalizePhone(c.callerId ?? "", country.code);
        if ("error" in phone) rowErrors.push(`callerId: ${phone.error}`);
        const startMs = checkDateTime(c.callStartDateTime, "callStartDateTime", rowErrors);
        const convMs = checkDateTime(c.conversionDateTime, "conversionDateTime", rowErrors);
        if (startMs !== null && convMs !== null && convMs < startMs) rowErrors.push("conversionDateTime anterior ao início da chamada");
        checkValue(c.conversionValue, "conversionValue", rowErrors);
        const currency = checkCurrency(c.currencyCode, "currencyCode", rowErrors);
        const consent = c.adUserDataConsent ?? adUserDataConsent;
        if (!consent) rowErrors.push("sem consentimento — informe adUserDataConsent (por linha ou padrão); o guia de chamadas exige");
        const customVariables: Row[] = [];
        for (const v of c.customVariables ?? []) {
          if (!/^\d+$/.test(v.id)) rowErrors.push(`customVariables.id "${v.id}" inválido`);
          else customVariables.push({ id: v.id, value: v.value });
        }
        if ("value" in phone && startMs !== null && convMs !== null) {
          const key = `${phone.value}|${startMs}|${convMs}`;
          if (keys.has(key)) rowErrors.push(`mesma chamada e conversionDateTime da linha ${keys.get(key)} — DUPLICATE_CALL_CONVERSION_IN_REQUEST`);
          else keys.set(key, n);
        }
        if (rowErrors.length || !("value" in phone)) {
          errors.push(...rowErrors.map((e) => `linha ${n}: ${e}`));
          return;
        }
        const row: Row = {
          callerId: phone.value,
          callStartDateTime: c.callStartDateTime.trim(),
          conversionDateTime: c.conversionDateTime.trim(),
          consent: { adUserData: consent },
        };
        if (c.conversionValue !== undefined) row.conversionValue = c.conversionValue;
        if (currency) row.currencyCode = currency;
        if (customVariables.length) row.customVariables = customVariables;
        built.push({ row, label: maskPhone(phone.value), needsCurrency: c.conversionValue !== undefined && !currency });
      });
      if (errors.length) return validationFailure(tool, errors);

      const client = getClient();
      const context = await resolveConversionContext(ctx, client, cid, conversionActionId);
      if ("error" in context) return { content: [text(context.error)], isError: true };
      const action = context.action;
      if (action.type !== "UPLOAD_CALLS" || action.status !== "ENABLED") {
        return {
          content: [text(`${contextLine(context)}\nImportação de chamadas exige ação UPLOAD_CALLS ativa (esta é ${action.type}, ${action.status}). Nada foi enviado.` +
            (action.type === "UPLOAD_CLICKS" ? " Para cliques, use upload_offline_conversion." : ""))],
          isError: true,
        };
      }
      const defaultCurrency = action.defaultCurrencyCode || context.requested.currencyCode || context.owner.currencyCode;
      const conversionAction = `customers/${context.uploadCustomerId}/conversionActions/${action.id}`;
      const payload = built.map((b) => {
        const row: Row = { conversionAction, ...b.row };
        if (b.needsCurrency && defaultCurrency) row.currencyCode = defaultCurrency;
        if (Array.isArray(row.customVariables)) {
          row.customVariables = (row.customVariables as Row[]).map((v) => ({
            conversionCustomVariable: `customers/${context.uploadCustomerId}/conversionCustomVariables/${v.id}`,
            value: v.value,
          }));
        }
        return row;
      });
      let result: Row;
      try {
        result = await client.customerWriteAction<Row>(context.uploadCustomerId, ":uploadCallConversions", {
          conversions: payload,
          partialFailure: true,
        });
      } catch (err) {
        return { content: [text(`${contextLine(context)}\nA API recusou o envio inteiro — nada foi gravado.\n${(err as Error).message}`)], isError: true };
      }
      const dryRun = client.isDryRun;
      const report = reportRows(payload.length, (i) => built[i].label, result, ["conversions"], dryRun);
      const header = dryRun
        ? `DRY-RUN (validateOnly): ${payload.length} chamada(s) validada(s), nada gravado — ${report.ok} válida(s), ${report.failed} com erro.`
        : `Upload de ${payload.length} conversão(ões) de chamada — ${report.ok} aceita(s), ${report.failed} recusada(s).`;
      const lines = [
        header,
        contextLine(context),
        ...(report.failed && report.ok ? ["ATENÇÃO: envio parcial — só as linhas abaixo falharam."] : []),
        ...(report.lines.length ? ["Linhas com erro:", ...report.lines] : []),
        ...(report.unattributed.length ? ["Erros sem linha:", ...report.unattributed.map((u) => `- ${u}`)] : []),
      ];
      return { content: [text(lines.join("\n"))], isError: report.ok === 0 };
    }
  );

  // ── get_conversion_upload_health ───────────────────────────────────

  mcp.registerTool(
    "get_conversion_upload_health",
    {
      description: [
        "Saúde da importação offline (cliques, chamadas, ajustes, store sales) — o diagnóstico do Google por origem",
        "(API, interface/SFTP, conectores de dados) e por ação de conversão.",
        "READ OPERATION.",
        "",
        "Traz status (EXCELLENT/GOOD/NEEDS_ATTENTION/NO_RECENT_UPLOAD), taxa de sucesso e de pendentes, último upload,",
        "os últimos 7 dias, os 7 últimos jobs (job_id) e os alertas (CLICK_NOT_FOUND, EXPIRED_EVENT, ORDER_ID_ALREADY_IN_USE…)",
        "com explicação. Os dados valem para a conta que FEZ o upload: por padrão a tool consulta a conta pedida e,",
        "se diferente, a conta de conversão (MCC com acompanhamento entre contas). Base: o último dia completo; pendentes",
        "podem levar até 24 h.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionActionId: z.string().optional().describe("Filtra o resumo por ação de conversão."),
        includeConversionCustomer: z.boolean().optional().describe("Também consulta a conta de conversão (default: true)."),
        topAlerts: z.number().optional().describe("Quantos alertas mostrar por resumo (default 5)."),
        format: formatSchema,
      },
    },
    async ({ customerId, conversionActionId, includeConversionCustomer, topAlerts, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["conversionActionId", conversionActionId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const top = topAlerts === undefined ? 5 : Math.trunc(topAlerts);
      if (!Number.isFinite(top) || top < 0 || top > 50) return { content: [text("topAlerts precisa estar entre 0 e 50.")], isError: true };
      const cid = customerId.replace(/-/g, "");
      const client = getClient();

      const accounts = [cid];
      const notes: string[] = [];
      if (includeConversionCustomer !== false) {
        const settings = await loadCustomerSettings(client, cid);
        const conversionCustomer = settings.conversionCustomerId;
        if (conversionCustomer && conversionCustomer !== cid) {
          if (checkCustomerAccess(conversionCustomer, allowedCustomerIds, hosted)) {
            notes.push(`A conta de conversão ${conversionCustomer} está fora da allowlist — o diagnóstico dela não foi consultado.`);
          } else {
            accounts.push(conversionCustomer);
          }
        }
      }

      const clientRows: Row[] = [];
      const actionRows: Row[] = [];
      for (const account of accounts) {
        const clients = await client.searchStream(
          account,
          `SELECT offline_conversion_upload_client_summary.client,
                  offline_conversion_upload_client_summary.status,
                  offline_conversion_upload_client_summary.total_event_count,
                  offline_conversion_upload_client_summary.successful_event_count,
                  offline_conversion_upload_client_summary.success_rate,
                  offline_conversion_upload_client_summary.pending_event_count,
                  offline_conversion_upload_client_summary.pending_rate,
                  offline_conversion_upload_client_summary.last_upload_date_time,
                  offline_conversion_upload_client_summary.daily_summaries,
                  offline_conversion_upload_client_summary.job_summaries,
                  offline_conversion_upload_client_summary.alerts
           FROM offline_conversion_upload_client_summary`
        );
        for (const r of clients) clientRows.push(summaryView(account, r.offlineConversionUploadClientSummary as Row, top));
        const actions = await client.searchStream(
          account,
          `SELECT offline_conversion_upload_conversion_action_summary.client,
                  offline_conversion_upload_conversion_action_summary.conversion_action_id,
                  offline_conversion_upload_conversion_action_summary.conversion_action_name,
                  offline_conversion_upload_conversion_action_summary.status,
                  offline_conversion_upload_conversion_action_summary.total_event_count,
                  offline_conversion_upload_conversion_action_summary.successful_event_count,
                  offline_conversion_upload_conversion_action_summary.pending_event_count,
                  offline_conversion_upload_conversion_action_summary.last_upload_date_time,
                  offline_conversion_upload_conversion_action_summary.daily_summaries,
                  offline_conversion_upload_conversion_action_summary.job_summaries,
                  offline_conversion_upload_conversion_action_summary.alerts
           FROM offline_conversion_upload_conversion_action_summary` +
            (conversionActionId ? `\n           WHERE offline_conversion_upload_conversion_action_summary.conversion_action_id = ${conversionActionId}` : "")
        );
        for (const r of actions) actionRows.push(summaryView(account, r.offlineConversionUploadConversionActionSummary as Row, top));
      }

      if (format === "table" || format === "csv") {
        const flat = [
          ...clientRows.map((r) => flatSummary("origem", r)),
          ...actionRows.map((r) => flatSummary("ação", r)),
        ];
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }

      const verdicts = [...clientRows, ...actionRows]
        .filter((r) => r.status === "NEEDS_ATTENTION" || r.status === "NO_RECENT_UPLOAD")
        .map((r) => `- conta ${r.account}, ${r.conversion_action_name ? `ação "${r.conversion_action_name}"` : `origem ${r.client_label}`}: ${r.status_label}` +
          ((r.alerts as Row[]).length ? ` — principal alerta: ${(r.alerts as Row[])[0].code} (${(r.alerts as Row[])[0].percent}%)` : ""));
      const header = clientRows.length + actionRows.length === 0
        ? `Nenhum diagnóstico de importação em ${accounts.join(", ")} — sem uploads recentes${conversionActionId ? ` para a ação ${conversionActionId}` : ""} ` +
          "(ou os uploads saíram de outra conta: o diagnóstico fica na conta que enviou)."
        : `Diagnóstico de importação offline (${accounts.join(", ")}): ${clientRows.length} origem(ns), ${actionRows.length} ação(ões).`;
      const body = [
        header,
        ...notes,
        ...(verdicts.length ? ["Precisa de atenção:", ...verdicts] : clientRows.length + actionRows.length ? ["Nenhuma origem/ação em NEEDS_ATTENTION ou NO_RECENT_UPLOAD."] : []),
      ].join("\n");
      return { content: [text(`${body}\n\n${formatJson({ by_client: clientRows, by_conversion_action: actionRows })}`)] };
    }
  );

  // ── lookup_gclid ───────────────────────────────────────────────────

  mcp.registerTool(
    "lookup_gclid",
    {
      description: [
        "Resolve GCLIDs pelo click_view: campanha, grupo, anúncio, palavra-chave (texto e correspondência), dispositivo,",
        "rede, local, página e lista de público do clique. Serve para atribuir leads do CRM e depurar importações",
        "(EVENT_NOT_FOUND / NO_CONVERSION_ACTION_FOUND).",
        "READ OPERATION.",
        "",
        "Limite da API: a consulta é por UM dia (a data do clique, no fuso da conta) e só até 90 dias atrás.",
        "Sem a data exata, use lookbackDays para varrer dias anteriores a partir de date (1 query por dia, para quando",
        "achar todos). GCLID não existe para campanhas de app de instalação/pré-registro. Consulte a conta do clique",
        "(a conta do anunciante), não a MCC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID da conta onde o clique aconteceu."),
        gclids: z.union([z.string(), z.array(z.string())]).describe("Um GCLID ou uma lista (até 100)."),
        date: z.string().describe("Data do clique YYYY-MM-DD (fuso da conta)."),
        lookbackDays: z.number().optional().describe("Também procura até N dias antes de date (0–30, default 0)."),
      },
    },
    async ({ customerId, gclids, date, lookbackDays }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const wanted = [...new Set(list(gclids).map((g) => g.trim()))];
      if (wanted.length === 0) return { content: [text("Informe ao menos um GCLID.")], isError: true };
      if (wanted.length > 100) return { content: [text(`Máximo de 100 GCLIDs por consulta (recebidos ${wanted.length}).`)], isError: true };
      const bad = wanted.filter((g) => !/^[A-Za-z0-9._~-]{8,512}$/.test(g));
      if (bad.length) return { content: [text(`GCLID(s) com formato inválido: ${bad.slice(0, 5).join(", ")} — o GCLID só tem letras, números, "-" e "_".`)], isError: true };
      if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        return { content: [text(`date inválida: "${date}" — use YYYY-MM-DD.`)], isError: true };
      }
      const back = lookbackDays === undefined ? 0 : lookbackDays;
      if (!Number.isInteger(back) || back < 0 || back > 30) return { content: [text("lookbackDays precisa ser inteiro entre 0 e 30.")], isError: true };
      const today = localIsoDate(new Date());
      const oldest = shiftIsoDate(today, -CLICK_VIEW_MAX_DAYS);
      if (date > today) return { content: [text(`date ${date} está no futuro.`)], isError: true };
      if (date < oldest) {
        return { content: [text(`O click_view só guarda os últimos ${CLICK_VIEW_MAX_DAYS} dias (a partir de ${oldest}); ${date} é antiga demais.`)], isError: true };
      }
      const cid = customerId.replace(/-/g, "");
      const client = getClient();
      const found = new Map<string, Row>();
      const scanned: string[] = [];
      for (let offset = 0; offset <= back; offset++) {
        const day = shiftIsoDate(date, -offset);
        if (day < oldest) break;
        const pending = wanted.filter((g) => !found.has(g));
        if (pending.length === 0) break;
        scanned.push(day);
        const rows = await client.searchStream(
          cid,
          `SELECT click_view.gclid, click_view.ad_group_ad, click_view.keyword,
                  click_view.keyword_info.text, click_view.keyword_info.match_type,
                  click_view.campaign_location_target, click_view.user_list,
                  click_view.area_of_interest.most_specific, click_view.location_of_presence.most_specific,
                  click_view.page_number, campaign.id, campaign.name, ad_group.id, ad_group.name,
                  segments.date, segments.device, segments.click_type, segments.ad_network_type, metrics.clicks
           FROM click_view
           WHERE segments.date = '${day}'
             AND click_view.gclid IN (${pending.map((g) => `'${gaqlLiteral(g)}'`).join(", ")})`
        );
        for (const r of rows) {
          const view = (r.clickView ?? {}) as Row;
          const gclid = String(view.gclid ?? "");
          if (!gclid || found.has(gclid)) continue;
          found.set(gclid, r);
        }
      }

      // Nomes dos locais (geoTargetConstants/N) numa query só
      const geoIds = new Set<string>();
      for (const r of found.values()) {
        const view = (r.clickView ?? {}) as Row;
        for (const value of [
          view.campaignLocationTarget,
          ((view.areaOfInterest ?? {}) as Row).mostSpecific,
          ((view.locationOfPresence ?? {}) as Row).mostSpecific,
        ]) {
          if (typeof value === "string" && /^geoTargetConstants\/\d+$/.test(value)) geoIds.add(value);
        }
      }
      const geoNames = new Map<string, string>();
      if (geoIds.size) {
        const geos = await client.searchStream(
          cid,
          `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name
           FROM geo_target_constant
           WHERE geo_target_constant.resource_name IN (${[...geoIds].map((g) => `'${g}'`).join(", ")})`
        );
        for (const g of geos) {
          const constant = (g.geoTargetConstant ?? {}) as Row;
          geoNames.set(String(constant.resourceName), String(constant.canonicalName ?? ""));
        }
      }
      const geo = (value: unknown) => (typeof value === "string" && value ? (geoNames.get(value) ? `${geoNames.get(value)} (${value})` : value) : null);

      const results = wanted.map((gclid) => {
        const r = found.get(gclid);
        if (!r) return { gclid, found: false };
        const view = (r.clickView ?? {}) as Row;
        const keywordInfo = (view.keywordInfo ?? {}) as Row;
        const campaign = (r.campaign ?? {}) as Row;
        const adGroup = (r.adGroup ?? {}) as Row;
        const segments = (r.segments ?? {}) as Row;
        return {
          gclid,
          found: true,
          date: segments.date,
          campaign: { id: campaign.id, name: campaign.name },
          ad_group: { id: adGroup.id, name: adGroup.name },
          ad_id: typeof view.adGroupAd === "string" ? view.adGroupAd.split("~").pop() : null,
          keyword: keywordInfo.text ? { text: keywordInfo.text, match_type: keywordInfo.matchType, criterion: view.keyword } : null,
          device: segments.device,
          network: segments.adNetworkType,
          click_type: segments.clickType,
          page_number: view.pageNumber ?? null,
          location_of_presence: geo(((view.locationOfPresence ?? {}) as Row).mostSpecific),
          area_of_interest: geo(((view.areaOfInterest ?? {}) as Row).mostSpecific),
          campaign_location_target: geo(view.campaignLocationTarget),
          user_list: view.userList ?? null,
          clicks: num((r.metrics as Row)?.clicks),
        };
      });
      const missing = results.filter((r) => !r.found).length;
      const lines = [
        `${results.length - missing} de ${results.length} GCLID(s) encontrado(s) na conta ${cid} (dias consultados: ${scanned.join(", ") || "nenhum"}).`,
        ...(missing
          ? [
              "Não encontrados — causas comuns: data do clique diferente (é a data no fuso da conta; aumente lookbackDays),",
              "clique de outra conta (consulte a conta do anunciante, não a MCC), clique com mais de 90 dias, GCLID",
              "truncado/alterado, ou campanha de app de instalação/pré-registro (sem GCLID).",
            ]
          : []),
      ];
      return { content: [text(`${lines.join("\n")}\n\n${formatJson(results)}`)] };
    }
  );

  // ── get_call_details ───────────────────────────────────────────────

  mcp.registerTool(
    "get_call_details",
    {
      description: [
        "Chamadas uma a uma (call_view) de anúncios de chamada e assets de ligação com número de encaminhamento do",
        "Google: início/fim, duração, status (MISSED/RECEIVED), DDD e país de quem ligou, origem (anúncio ou página),",
        "tipo e campanha/grupo. Resume perdidas, curtas e por campanha — auditoria de call tracking de lead-gen.",
        "READ OPERATION.",
        "",
        "O DDD vem vazio em chamadas com menos de 15 s. Janela: days (default 30, inclui hoje) ou dateRange.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe("Últimos N dias, incluindo hoje (default 30)."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        callStatus: z.enum(["MISSED", "RECEIVED"]).optional().describe("Só perdidas ou só atendidas."),
        minDurationSeconds: z.number().optional().describe("Duração mínima (s)."),
        maxDurationSeconds: z.number().optional().describe("Duração máxima (s) — ex.: 30 para achar chamadas curtas."),
        shortCallSeconds: z.number().optional().describe("Limite de 'chamada curta' no resumo (default 60, o padrão de conversão)."),
        limit: z.number().optional().describe("Máximo de chamadas listadas (default 500, máx. 10000)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, callStatus, minDurationSeconds, maxDurationSeconds, shortCallSeconds, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const idError = checkIds([["customerId", customerId], ["campaignId", campaignId]]);
      if (idError) return { content: [text(idError)], isError: true };
      const window = callWindow(dateRange, days);
      if ("error" in window) return { content: [text(window.error)], isError: true };
      for (const [label, value] of [["minDurationSeconds", minDurationSeconds], ["maxDurationSeconds", maxDurationSeconds], ["shortCallSeconds", shortCallSeconds]] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) return { content: [text(`${label} precisa ser inteiro ≥ 0.`)], isError: true };
      }
      if (minDurationSeconds !== undefined && maxDurationSeconds !== undefined && minDurationSeconds > maxDurationSeconds) {
        return { content: [text("minDurationSeconds maior que maxDurationSeconds.")], isError: true };
      }
      const max = limit === undefined ? 500 : limit;
      if (!Number.isInteger(max) || max < 1 || max > 10000) return { content: [text("limit precisa ser inteiro entre 1 e 10000.")], isError: true };
      const short = shortCallSeconds ?? DEFAULT_SHORT_CALL_SECONDS;
      const where = [
        `call_view.start_call_date_time >= '${window.since} 00:00:00'`,
        `call_view.start_call_date_time <= '${window.until} 23:59:59'`,
        ...(campaignId ? [`campaign.id = ${campaignId.replace(/-/g, "")}`] : []),
        ...(callStatus ? [`call_view.call_status = '${callStatus}'`] : []),
        ...(minDurationSeconds !== undefined ? [`call_view.call_duration_seconds >= ${minDurationSeconds}`] : []),
        ...(maxDurationSeconds !== undefined ? [`call_view.call_duration_seconds <= ${maxDurationSeconds}`] : []),
      ];
      const client = getClient();
      const rows = await client.searchStream(
        customerId,
        `SELECT call_view.resource_name, call_view.caller_country_code, call_view.caller_area_code,
                call_view.call_duration_seconds, call_view.start_call_date_time, call_view.end_call_date_time,
                call_view.call_status, call_view.call_tracking_display_location, call_view.type,
                campaign.id, campaign.name, ad_group.id, ad_group.name
         FROM call_view
         WHERE ${where.join("\n           AND ")}
         ORDER BY call_view.start_call_date_time DESC
         LIMIT ${max}`
      );
      const calls = rows.map((r) => {
        const view = (r.callView ?? {}) as Row;
        const campaign = (r.campaign ?? {}) as Row;
        const adGroup = (r.adGroup ?? {}) as Row;
        return {
          start: view.startCallDateTime,
          end: view.endCallDateTime,
          duration_s: num(view.callDurationSeconds),
          status: view.callStatus,
          caller_country: view.callerCountryCode ?? null,
          caller_area_code: view.callerAreaCode ?? null,
          source: view.callTrackingDisplayLocation,
          type: view.type,
          campaign_id: campaign.id,
          campaign: campaign.name,
          ad_group_id: adGroup.id ?? null,
          ad_group: adGroup.name ?? null,
        };
      });
      if (format === "table") return { content: [text(formatAsTable(calls))] };
      if (format === "csv") return { content: [text(formatAsCsv(calls))] };

      const received = calls.filter((c) => c.status === "RECEIVED");
      const missed = calls.filter((c) => c.status === "MISSED").length;
      const byCampaign = new Map<string, { campaign: unknown; calls: number; missed: number; received: number; short: number; total_s: number }>();
      for (const c of calls) {
        const key = String(c.campaign_id ?? "?");
        const entry = byCampaign.get(key) ?? { campaign: c.campaign, calls: 0, missed: 0, received: 0, short: 0, total_s: 0 };
        entry.calls++;
        if (c.status === "MISSED") entry.missed++;
        if (c.status === "RECEIVED") {
          entry.received++;
          entry.total_s += c.duration_s;
          if (c.duration_s < short) entry.short++;
        }
        byCampaign.set(key, entry);
      }
      const summary = {
        period: `${window.since} a ${window.until}`,
        calls: calls.length,
        received: received.length,
        missed,
        missed_rate_pct: calls.length ? round2((missed / calls.length) * 100) : 0,
        avg_duration_received_s: received.length ? round2(received.reduce((s, c) => s + c.duration_s, 0) / received.length) : null,
        [`short_received_under_${short}s`]: received.filter((c) => c.duration_s < short).length,
        by_campaign: [...byCampaign.entries()].map(([id, e]) => ({
          campaign_id: id,
          campaign: e.campaign,
          calls: e.calls,
          missed: e.missed,
          missed_rate_pct: e.calls ? round2((e.missed / e.calls) * 100) : 0,
          short_received: e.short,
          avg_duration_received_s: e.received ? round2(e.total_s / e.received) : null,
        })).sort((a, b) => b.calls - a.calls),
        truncated: calls.length === max,
      };
      return {
        content: [text(
          `${calls.length} chamada(s) em ${summary.period}${calls.length === max ? ` (limite de ${max} — aumente limit ou estreite o período)` : ""}: ` +
          `${missed} perdida(s) (${summary.missed_rate_pct}%), ${received.length} atendida(s).\n\n` +
          formatJson({ summary, calls })
        )],
      };
    }
  );
}

// ── Auxiliares de leitura ────────────────────────────────────────────

function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Janela de call_view (sem segments.date): filtra por start_call_date_time. days inclui hoje. */
function callWindow(dateRange: { since: string; until: string } | undefined, days: number | undefined): { since: string; until: string } | { error: string } {
  if (dateRange && (dateRange.since || dateRange.until)) {
    if (!ISO_DATE.test(dateRange.since ?? "") || !ISO_DATE.test(dateRange.until ?? "")) {
      return { error: `dateRange inválido — use YYYY-MM-DD (recebido ${dateRange.since} → ${dateRange.until}).` };
    }
    if (dateRange.since > dateRange.until) return { error: "dateRange.since depois de until." };
    return { since: dateRange.since, until: dateRange.until };
  }
  const n = days ?? 30;
  if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: `days inválido: ${days}. Use um inteiro entre 1 e 3650.` };
  const until = localIsoDate(new Date());
  return { since: shiftIsoDate(until, -(n - 1)), until };
}

const STATUS_LABELS: Record<string, string> = {
  EXCELLENT: "Excelente",
  GOOD: "Bom — há melhorias possíveis (veja os alertas)",
  NEEDS_ATTENTION: "Precisa de atenção — há erros (veja os alertas)",
  NO_RECENT_UPLOAD: "Sem upload nos últimos 28 dias",
};

const CLIENT_LABELS: Record<string, string> = {
  GOOGLE_ADS_API: "Google Ads API (inclui este MCP)",
  GOOGLE_ADS_WEB_CLIENT: "interface do Google Ads (UI, SFTP, planilhas)",
  ADS_DATA_CONNECTOR: "conectores de dados",
};

const DM_STATUS_LABELS: Record<string, string> = {
  SUCCESS: "processado sem erros (pode haver avisos)",
  PROCESSING: "em processamento",
  PARTIAL_SUCCESS: "processado com erros em parte dos registros",
  FAILED: "falhou para todos os registros",
  REQUEST_STATUS_UNKNOWN: "status desconhecido",
};

const ERROR_FAMILY: Record<string, string> = {
  conversionUploadError: "upload de conversão",
  conversionAdjustmentUploadError: "ajuste de conversão",
  collectionSizeError: "tamanho do lote",
  dateError: "data",
  distinctError: "duplicidade",
  fieldError: "campo",
  mutateError: "gravação",
  notAllowlistedError: "acesso restrito",
  stringFormatError: "formato",
  stringLengthError: "tamanho de texto",
};

function summaryView(account: string, summary: Row | undefined, top: number): Row {
  const s = summary ?? {};
  const total = num(s.totalEventCount);
  const successful = num(s.successfulEventCount);
  const pending = num(s.pendingEventCount);
  const successRate = s.successRate !== undefined ? num(s.successRate) : total ? successful / total : 0;
  const pendingRate = s.pendingRate !== undefined ? num(s.pendingRate) : total ? pending / total : 0;
  const summaries = (value: unknown) =>
    ((value as Row[]) ?? []).map((d) => ({
      ...(d.uploadDate !== undefined ? { date: d.uploadDate } : {}),
      ...(d.jobId !== undefined ? { job_id: d.jobId } : {}),
      successful: num(d.successfulCount),
      failed: num(d.failedCount),
      pending: num(d.pendingCount),
    }));
  const alerts = ((s.alerts as Row[]) ?? [])
    .map((alert) => {
      const [family, code] = Object.entries((alert.error as Row) ?? {})[0] ?? ["", ""];
      return {
        code: String(code),
        family: ERROR_FAMILY[family] ?? family,
        percent: round2(num(alert.errorPercentage) * 100),
        hint: ERROR_HINTS[String(code)] ?? null,
      };
    })
    .sort((a, b) => b.percent - a.percent)
    .slice(0, top);
  return {
    account,
    client: s.client,
    client_label: CLIENT_LABELS[String(s.client)] ?? String(s.client ?? ""),
    ...(s.conversionActionId !== undefined ? { conversion_action_id: s.conversionActionId, conversion_action_name: s.conversionActionName } : {}),
    status: s.status,
    status_label: STATUS_LABELS[String(s.status)] ?? String(s.status ?? ""),
    total_events: total,
    successful_events: successful,
    success_rate_pct: round2(successRate * 100),
    pending_events: pending,
    pending_rate_pct: round2(pendingRate * 100),
    last_upload: s.lastUploadDateTime ?? null,
    last_7_days: summaries(s.dailySummaries),
    last_jobs: summaries(s.jobSummaries),
    alerts,
  };
}

function flatSummary(level: string, r: Row): Row {
  const alerts = r.alerts as Array<{ code: string; percent: number }>;
  return {
    nivel: level,
    conta: r.account,
    origem: r.client,
    acao: r.conversion_action_name ?? "",
    status: r.status,
    eventos: r.total_events,
    sucesso_pct: r.success_rate_pct,
    pendentes_pct: r.pending_rate_pct,
    ultimo_upload: r.last_upload ?? "",
    principal_alerta: alerts[0] ? `${alerts[0].code} (${alerts[0].percent}%)` : "",
  };
}

/** Traduz os erros mais comuns da Data Manager API (escopo, API desativada, permissão). */
export function explainDataManagerError(message: string, authMode: "oauth_user" | "service_account" = "oauth_user"): string {
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(message)) {
    if (authMode === "service_account") {
      return "A Data Manager API recusou o token da service account por escopo, embora o JWT peça adwords E datamanager. " +
        "Confira se a Data Manager API está ativada no projeto do Google Cloud da service account e se ela tem acesso " +
        "à conta de conversão no Google Ads. Nada foi gravado.\n" + message;
    }
    return "A Data Manager API recusou o token: falta o escopo https://www.googleapis.com/auth/datamanager. " +
      "Gere um novo refresh token consentindo adwords E datamanager (o app OAuth precisa ter o escopo em Data Access; " +
      "por ser sensível, pode exigir verificação do Google). Nada foi gravado.\n" + message;
  }
  if (/SERVICE_DISABLED|has not been used in project|it is disabled|API has not been enabled/i.test(message)) {
    return "A Data Manager API não está ativada no projeto do Google Cloud deste OAuth. Ative-a no console " +
      "(APIs e serviços → Data Manager API) e tente de novo. Nada foi gravado.\n" + message;
  }
  if (/PERMISSION_DENIED|HTTP 403/i.test(message)) {
    return "A Data Manager API negou acesso: o usuário do token (ou a service account) precisa ter acesso de escrita à conta de conversão " +
      "(direto ou pela conta de login). Nada foi gravado.\n" + message;
  }
  return `A Data Manager API recusou a requisição (modelo fast-fail: nada foi gravado).\n${message}`;
}
