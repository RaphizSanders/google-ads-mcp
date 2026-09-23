/**
 * Lote conversions-reporting: detalhamento de conversões (por ação, atraso), regras de valor,
 * lift (Conversion/Brand Lift) e formulários de lead, mais get_purchase_conversions.
 *
 * O client falso passa toda query por assertGaqlRules (metadados reais da v25) e, além disso,
 * pela tabela "Selectable with" da referência de campos v25 (fields/v25/segments e /metrics),
 * extraída para os campos que estas tools usam: o validador compartilhado não confere se um
 * segmento combina com uma métrica (ex.: segments.conversion_action com metrics.cost_micros, ou
 * segments.conversion_value_rule_primary_dimension com metrics.original_conversion_value — a API
 * recusa os dois).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { CHAINED_WRITE_TOOLS, localIsoDate } from "../src/tool-kit.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { catalog } from "../src/tools/conversions-reporting.catalog.js";
import { assertGaqlRules } from "./gaql-rules.js";
import { parseGaql } from "./gaql-validator.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";

/**
 * errors[].message que a API devolve = comentário do enum no proto v25 (quebras de linha viram espaço).
 * errors/conversion_value_rule_error.proto, conversion_value_rule_set_error.proto, database_error.proto,
 * asset_error.proto, policy_finding_error.proto, policy_violation_error.proto. O GoogleAdsClient joga fora o
 * errorCode, então as dicas precisam casar com ESTE texto — os testes nunca usam o nome do enum na mensagem.
 */
const API_MESSAGES = {
  CONFLICTING_CONDITIONS: "User specified conflicting conditions for two value rules in the same value rule set.",
  CONFLICTING_VALUE_RULE_CONDITIONS: "Two value rules in this value rule set contain conflicting conditions.",
  CONDITION_NOT_ALLOWED: "The value rule contains a condition that's not allowed by the value rule set including this value rule.",
  CONDITION_TYPE_NOT_ALLOWED: "An error that's thrown when a mutate is adding new value rule(s) into a value rule set and the added value rule(s) include conditions that are not specified in the dimensions of the value rule set.",
  VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE: "This value rule set is attached to a campaign that does not support value rules. Currently, campaign level value rule sets can only be created on Search, or Display campaigns.",
  CANNOT_REMOVE_IF_INCLUDED_IN_VALUE_RULE_SET: "The value rule cannot be removed because it's still included in some value rule set.",
  CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED: "Pausing the value rule requires pausing the value rule set because the value rule is (one of) the last enabled in the value rule set.",
  CANNOT_PAUSE_UNLESS_ALL_VALUE_RULES_ARE_PAUSED: "When a mutate request tries to pause a value rule set, the enabled value rules in this set must be paused in the same command, or this error will be thrown.",
  SHOULD_PAUSE_WHEN_ALL_VALUE_RULES_ARE_PAUSED: "When a mutate request tries to pause all the value rules in a value rule set, the value rule set must be paused, or this error will be thrown.",
  DIMENSIONS_UPDATE_ONLY_ALLOW_APPEND: "An error that's thrown when a mutate operation is trying to replace/remove some existing elements in the dimensions field. In other words, ADD op is always fine and UPDATE op is fine if it's only appending new elements into dimensions list.",
  INVALID_GEO_TARGET_CONSTANT: "The value rule's geo location condition contains invalid geo target constant(s), for example, there's no matching geo target.",
  CONFLICTING_INCLUDED_AND_EXCLUDED_GEO_TARGET: "The value rule's geo location condition contains conflicting included and excluded geo targets. Specifically, some of the excluded geo target(s) are the same as or contain some of the included geo target(s). For example, the geo location condition includes California but excludes U.S.",
  UNTARGETABLE_GEO_TARGET: "The value rule's geo location condition contains untargetable geo target constant(s).",
  INVALID_AUDIENCE_USER_LIST: "The value rule's audience condition contains invalid user list(s). In another word, there's no matching user list.",
  INACCESSIBLE_USER_LIST: "The value rule's audience condition contains inaccessible user list(s).",
  INVALID_AUDIENCE_USER_INTEREST: "The value rule's audience condition contains invalid user_interest(s). This might be because there is no matching user interest, or the user interest is not visible.",
  DATA_CONSTRAINT_VIOLATION: "The request conflicted with existing data. This error will usually be replaced with a more specific error if the request is retried.",
  LEAD_FORM_MISSING_AGREEMENT: "Lead forms require that the Terms of Service have been agreed to before mutates can be executed.",
  LEAD_FORM_INVALID_FIELDS_COMBINATION: "A lead form asset is created with an invalid combination of input fields.",
  LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED: "Legacy qualifying questions cannot be in the same Lead Form as custom questions.",
  LEAD_FORM_LOCATION_ANSWER_TYPE_DISALLOWED: "Lead Form is disallowed to use `LOCATION` answer type.",
  DUPLICATE_ASSET_NAME: "The asset name is duplicated, either across operations or with an existing asset.",
  NAME_CONFLICT_FOR_ASSET_TYPE: "Unique name is required for this asset type.",
  POLICY_FINDING: "The resource has been disapproved since the policy summary includes policy topics of type PROHIBITED.",
  POLICY_ERROR: "A policy was violated. See PolicyViolationDetails for more detail.",
} as const;

// ── "Selectable with" (referência de campos v25), restrito aos campos usados aqui ──

const SEGMENT_COMPAT: Record<string, string[]> = {
  conversion_action: ["campaign", "customer", "lift_measurement_config", "age_range", "conversion_action_category", "conversion_action_name",
    "conversion_lag_bucket", "conversion_lift_conversion_category", "conversion_lift_end_date", "conversion_lift_included_conversion_action_types",
    "conversion_lift_start_date", "country", "country_localized_name", "date", "device", "gender"],
  conversion_action_name: ["campaign", "customer", "lift_measurement_config", "age_range", "conversion_action", "conversion_action_category",
    "conversion_lag_bucket", "conversion_lift_conversion_category", "conversion_lift_end_date", "conversion_lift_included_conversion_action_types",
    "conversion_lift_start_date", "country", "country_localized_name", "date", "device", "gender"],
  conversion_action_category: ["campaign", "customer", "conversion_action", "conversion_action_name", "conversion_lag_bucket", "date", "device"],
  conversion_lag_bucket: ["campaign", "customer", "conversion_action", "conversion_action_category", "conversion_action_name", "date"],
  conversion_value_rule_primary_dimension: ["campaign", "customer", "date"],
  date: ["campaign", "customer", "lift_measurement_age_range", "lift_measurement_campaign", "lift_measurement_config", "lift_measurement_device",
    "lift_measurement_gender", "lift_measurement_video", "brand_lift_measurement_type", "conversion_action", "conversion_action_category",
    "conversion_action_name", "conversion_lag_bucket", "conversion_value_rule_primary_dimension", "device"],
  conversion_lift_start_date: ["lift_measurement_config", "age_range", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category",
    "conversion_lift_end_date", "conversion_lift_included_conversion_action_types", "country", "country_localized_name", "device", "experiment_arm", "gender"],
  conversion_lift_end_date: ["lift_measurement_config", "age_range", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "country", "country_localized_name", "device", "experiment_arm", "gender"],
  conversion_lift_conversion_category: ["lift_measurement_config", "age_range", "conversion_action", "conversion_action_name", "conversion_lift_end_date",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "country", "country_localized_name", "device", "experiment_arm", "gender"],
  conversion_lift_included_conversion_action_types: ["lift_measurement_config", "age_range", "conversion_action", "conversion_action_name",
    "conversion_lift_conversion_category", "conversion_lift_end_date", "conversion_lift_start_date", "country", "country_localized_name", "device",
    "experiment_arm", "gender"],
  age_range: ["lift_measurement_config", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category", "conversion_lift_end_date",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date"],
  gender: ["lift_measurement_config", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category", "conversion_lift_end_date",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date"],
  device: ["campaign", "customer", "lift_measurement_config", "conversion_action", "conversion_action_category", "conversion_action_name",
    "conversion_lift_conversion_category", "conversion_lift_end_date", "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "date"],
  country: ["lift_measurement_config", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category", "conversion_lift_end_date",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "country_localized_name"],
  country_localized_name: ["lift_measurement_config", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category",
    "conversion_lift_end_date", "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "country"],
  experiment_arm: ["lift_measurement_config", "conversion_lift_conversion_category", "conversion_lift_end_date",
    "conversion_lift_included_conversion_action_types", "conversion_lift_start_date"],
  brand_lift_measurement_type: ["lift_measurement_age_range", "lift_measurement_campaign", "lift_measurement_config", "lift_measurement_device",
    "lift_measurement_gender", "lift_measurement_video", "date"],
};

const CONVERSION_LIFT_WITH = ["lift_measurement_config", "age_range", "conversion_action", "conversion_action_name", "conversion_lift_conversion_category",
  "conversion_lift_end_date", "conversion_lift_included_conversion_action_types", "conversion_lift_start_date", "country", "country_localized_name",
  "device", "experiment_arm", "gender"];
const METRIC_GROUPS: Array<{ metrics: string[]; with: string[] }> = [
  { metrics: ["conversions", "all_conversions", "conversions_by_conversion_date", "all_conversions_by_conversion_date"],
    with: ["campaign", "customer", "conversion_action", "conversion_action_category", "conversion_action_name", "conversion_lag_bucket", "date", "device"] },
  { metrics: ["conversions_value", "all_conversions_value", "conversions_value_by_conversion_date"],
    with: ["campaign", "customer", "conversion_action", "conversion_action_category", "conversion_action_name", "conversion_lag_bucket",
      "conversion_value_rule_primary_dimension", "date", "device"] },
  { metrics: ["view_through_conversions"], with: ["campaign", "customer", "conversion_action", "conversion_action_category", "conversion_action_name", "date", "device"] },
  { metrics: ["original_conversion_value"], with: ["campaign", "customer", "conversion_action", "conversion_action_category", "conversion_action_name", "conversion_lag_bucket", "date"] },
  { metrics: ["incremental_conversions", "incremental_conversions_p90_lower_bound", "incremental_conversions_p90_upper_bound", "incremental_conversions_p_value",
    "incremental_conversion_value", "incremental_conversion_value_p90_lower_bound", "incremental_conversion_value_p90_upper_bound",
    "incremental_conversion_value_p_value", "incremental_conversion_value_per_cost", "incremental_conversion_value_per_cost_p90_lower_bound",
    "incremental_conversion_value_per_cost_p90_upper_bound", "relative_conversion_lift", "relative_conversion_lift_p90_lower_bound",
    "relative_conversion_lift_p90_upper_bound", "relative_conversion_value_lift", "relative_conversion_value_lift_p90_lower_bound",
    "relative_conversion_value_lift_p90_upper_bound", "cost_per_incremental_conversion", "cost_per_incremental_conversion_p90_lower_bound",
    "cost_per_incremental_conversion_p90_upper_bound", "conversion_lift_baseline_conversions", "conversion_lift_exposed_conversions",
    "conversion_lift_baseline_conversion_value", "conversion_lift_exposed_conversion_value"], with: CONVERSION_LIFT_WITH },
  { metrics: ["incremental_conversions_winner_score", "incremental_conversion_value_winner_score", "incremental_conversion_value_per_cost_winner_score",
    "cost_per_incremental_conversion_winner_score"],
    with: ["lift_measurement_config", "conversion_lift_conversion_category", "conversion_lift_end_date", "conversion_lift_included_conversion_action_types",
      "conversion_lift_start_date", "experiment_arm"] },
  { metrics: ["absolute_brand_lift", "absolute_brand_lift_p90_lower_bound", "absolute_brand_lift_p90_upper_bound", "absolute_brand_lift_p_value",
    "relative_brand_lift", "relative_brand_lift_p90_lower_bound", "relative_brand_lift_p90_upper_bound", "headroom_brand_lift",
    "headroom_brand_lift_p90_lower_bound", "headroom_brand_lift_p90_upper_bound", "brand_lift_baseline_positive_response_rate",
    "brand_lift_exposed_positive_response_rate", "brand_lift_total_responses", "brand_lift_responses_exposed", "brand_lift_responses_suppressed",
    "fractional_lifted_cookies", "fractional_lifted_cookies_p90_lower_bound", "fractional_lifted_cookies_p90_upper_bound", "cost_per_lifted_cookie",
    "cost_per_lifted_cookie_p90_lower_bound", "cost_per_lifted_cookie_p90_upper_bound"],
    with: ["lift_measurement_age_range", "lift_measurement_campaign", "lift_measurement_config", "lift_measurement_device", "lift_measurement_gender",
      "lift_measurement_video", "brand_lift_measurement_type", "date"] },
  // Métricas de custo/clique/impressão: não combinam com os segmentos de conversão.
  { metrics: ["cost_micros", "clicks", "impressions"], with: ["campaign", "customer", "date", "device"] },
];

function assertSelectableTogether(query: string): void {
  const parsed = parseGaql(query);
  const fields = [...new Set([...parsed.select, ...parsed.where])];
  const segments = fields.filter((f) => f.startsWith("segments.")).map((f) => f.slice("segments.".length));
  const metrics = fields.filter((f) => f.startsWith("metrics.")).map((f) => f.slice("metrics.".length));
  for (const segment of segments) {
    const compat = SEGMENT_COMPAT[segment];
    assert.ok(compat, `segments.${segment} fora da tabela de compatibilidade do teste`);
    assert.ok(compat.includes(parsed.from), `segments.${segment} não é selecionável com FROM ${parsed.from}`);
    for (const other of segments) {
      if (other !== segment) assert.ok(compat.includes(other), `segments.${segment} não combina com segments.${other}`);
    }
  }
  for (const metric of metrics) {
    const group = METRIC_GROUPS.find((g) => g.metrics.includes(metric));
    assert.ok(group, `metrics.${metric} fora da tabela de compatibilidade do teste`);
    assert.ok(group.with.includes(parsed.from), `metrics.${metric} não é selecionável com FROM ${parsed.from}`);
    for (const segment of segments) {
      assert.ok(group.with.includes(segment), `metrics.${metric} não combina com segments.${segment}`);
    }
  }
}

test("a tabela de compatibilidade pega combinações que a API recusa", () => {
  assert.throws(() => assertSelectableTogether(
    "SELECT segments.conversion_action, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS"), /cost_micros/);
  assert.throws(() => assertSelectableTogether(
    "SELECT segments.conversion_value_rule_primary_dimension, metrics.original_conversion_value FROM customer"), /original_conversion_value/);
  assert.throws(() => assertSelectableTogether(
    "SELECT segments.conversion_lag_bucket, metrics.view_through_conversions FROM customer"), /view_through_conversions/);
  assert.throws(() => assertSelectableTogether(
    "SELECT segments.age_range, metrics.incremental_conversions_winner_score FROM lift_measurement_config"), /winner_score/);
});

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  respond?: (from: string, query: string) => Row[] | undefined;
  dryRun?: boolean;
  batchMutate?: (operations: Row[]) => Row | Promise<Row>;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row | Promise<Row>;
}

interface Write {
  method: string;
  operations: Row[];
  options?: Row;
  dryRun: boolean;
}

const RESULT_KEYS: Record<string, [string, string]> = {
  conversionValueRuleOperation: ["conversionValueRuleResult", "conversionValueRules/900"],
  conversionValueRuleSetOperation: ["conversionValueRuleSetResult", "conversionValueRuleSets/800"],
  assetOperation: ["assetResult", "assets/700"],
  campaignAssetOperation: ["campaignAssetResult", "campaignAssets/1~700~LEAD_FORM"],
};

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[] };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      assertSelectableTogether(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      return opts.respond?.(from, query) ?? [];
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op) => {
          const [kind] = Object.keys(op);
          const [key, path] = RESULT_KEYS[kind];
          return { [key]: { resourceName: `customers/${CID}/${path}` } };
        }),
      };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: `mutate:${resource}`, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations, options);
      if (dryRun) return {};
      return { results: operations.map((op) => ({ resourceName: String(op.remove ?? `customers/${CID}/${resource}/1`) })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, [], false);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = Math.min(...["{", "["].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  return JSON.parse(body.slice(start)) as Row;
}
/** IDs pedidos num "campo IN (...)" da query. */
const idsIn = (query: string, field: string) =>
  (new RegExp(`${field.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(query)?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean);

// ── Catálogo e validateOnly ──────────────────────────────────────────

test("catálogo: leituras e escritas do lote classificadas; validateOnly só nas escritas e nenhuma encadeada", () => {
  const { configs } = register(fakeClient().client);
  for (const name of catalog.read) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), name);
    assert.ok(configs.has(name), `${name} não registrada`);
    assert.equal((configs.get(name)!.inputSchema as Row).validateOnly, undefined, `${name} é leitura`);
  }
  for (const name of catalog.write) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), name);
    assert.ok((configs.get(name)!.inputSchema as Row).validateOnly, `${name} sem validateOnly`);
    assert.ok(!CHAINED_WRITE_TOOLS.has(name), `${name} é atômica, não encadeada`);
  }
  assert.deepEqual(catalog.chained, []);
});

// ── get_conversions_by_action ────────────────────────────────────────

const actionRow = (campaignId: string, actionId: string, name: string, category: string, m: Row): Row => ({
  campaign: { id: campaignId, name: `Campanha ${campaignId}` },
  segments: { conversionAction: `customers/${CID}/conversionActions/${actionId}`, conversionActionName: name, conversionActionCategory: category },
  metrics: m,
});
const actionConfig = (id: string, include: boolean): Row => ({
  conversionAction: { resourceName: `customers/${CID}/conversionActions/${id}`, name: `Ação ${id}`, status: "ENABLED", primaryForGoal: include, includeInConversionsMetric: include },
});
const byActionRows = (from: string): Row[] | undefined => {
  if (from === "campaign") {
    return [
      actionRow("11", "501", "Compra", "PURCHASE", { conversions: 10, conversionsValue: 1000, allConversions: 10, allConversionsValue: 1000, viewThroughConversions: "2" }),
      actionRow("12", "501", "Compra", "PURCHASE", { conversions: 5, conversionsValue: 400, allConversions: 5, allConversionsValue: 400 }),
      actionRow("11", "502", "Clique no WhatsApp", "CONTACT", { conversions: 0, allConversions: 30, allConversionsValue: 0 }),
    ];
  }
  if (from === "conversion_action") return [actionConfig("501", true), actionConfig("502", false)];
  return undefined;
};

test("get_conversions_by_action: soma por ação e separa primárias de secundárias", async () => {
  const { client, calls } = fakeClient({ respond: byActionRows });
  const result = await call(client, "get_conversions_by_action", { days: 30 });
  assert.equal(result.isError, undefined);
  const rows = jsonOf(result) as unknown as Row[];
  const purchase = rows.find((r) => r.conversion_action_id === "501")!;
  assert.equal(purchase.conversions, 15);
  assert.equal(purchase.conversions_value, 1400);
  assert.equal(purchase.view_through_conversions, 2);
  assert.equal(purchase.campaigns, 2);
  assert.equal(purchase.in_conversions_column, true);
  const whatsapp = rows.find((r) => r.conversion_action_id === "502")!;
  assert.equal(whatsapp.in_conversions_column, false);
  assert.equal(whatsapp.secondary_conversions, 30);
  assert.match(textOf(result), /Coluna Conversões \(primárias\): 15/);
  assert.match(textOf(result), /Todas as conversões: 45/);
  assert.match(textOf(result), /secundárias.*Clique no WhatsApp/);
  assert.match(calls.queries[0], /FROM campaign/);
  assert.match(calls.queries[0], /segments\.date DURING LAST_30_DAYS/);
  assert.doesNotMatch(calls.queries[0], /cost_micros|metrics\.clicks|impressions/);
});

test("get_conversions_by_action: includeSecondary=false, campanha e categoria (LEAD vira SUBMIT_LEAD_FORM)", async () => {
  const only = fakeClient({ respond: byActionRows });
  const rows = jsonOf(await call(only.client, "get_conversions_by_action", { includeSecondary: false })) as unknown as Row[];
  assert.deepEqual(rows.map((r) => r.conversion_action_id), ["501"]);

  const filtered = fakeClient({ respond: byActionRows });
  await call(filtered.client, "get_conversions_by_action", { campaignId: "11", category: "LEAD", breakdown: "campaign" });
  assert.match(filtered.calls.queries[0], /campaign\.id = 11/);
  assert.match(filtered.calls.queries[0], /segments\.conversion_action_category = 'SUBMIT_LEAD_FORM'/);

  const perCampaign = fakeClient({ respond: byActionRows });
  const split = jsonOf(await call(perCampaign.client, "get_conversions_by_action", { breakdown: "campaign" })) as unknown as Row[];
  assert.equal(split.filter((r) => r.conversion_action_id === "501").length, 2);
  assert.ok(split.every((r) => r.campaign_id));
});

test("get_conversions_by_action: entrada inválida não consulta; csv sai tabular", async () => {
  const { client, calls } = fakeClient({ respond: byActionRows });
  for (const args of [{ campaignId: "1 OR 1=1" }, { dateRange: { since: "2026-01-01' OR '1'='1", until: "2026-01-31" } }, { days: 0 }]) {
    const result = await call(client, "get_conversions_by_action", args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
  const csv = textOf(await call(client, "get_conversions_by_action", { format: "csv" }));
  assert.match(csv.split("\n")[0], /^conversion_action_id,conversion_action,/);
});

// ── get_conversion_lag ───────────────────────────────────────────────

/** Data local (YYYY-MM-DD) de N dias atrás — a janela padrão (days) termina ontem. */
const daysAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return localIsoDate(date);
};

const lagBucketRows = (): Row[] => [
  { segments: { conversionLagBucket: "LESS_THAN_ONE_DAY" }, metrics: { conversions: 50, allConversions: 60, conversionsValue: 500 } },
  { segments: { conversionLagBucket: "ONE_TO_TWO_DAYS" }, metrics: { conversions: 20, allConversions: 20, conversionsValue: 200 } },
  { segments: { conversionLagBucket: "SEVEN_TO_EIGHT_DAYS" }, metrics: { conversions: 20, allConversions: 20, conversionsValue: 200 } },
  { segments: { conversionLagBucket: "FOURTEEN_TO_TWENTY_ONE_DAYS" }, metrics: { conversions: 10, allConversions: 10, conversionsValue: 100 } },
  { segments: { conversionLagBucket: "UNKNOWN" }, metrics: { conversions: 7, allConversions: 7 } },
];

/** Mundo do atraso: buckets fixos e, por dia, as linhas dadas (padrão: anteontem e ontem). */
const lagWorld = (daily: Row[] = [
  { segments: { date: daysAgo(2) }, metrics: { conversions: 4, conversionsByConversionDate: 6, allConversions: 4, allConversionsByConversionDate: 6 } },
  { segments: { date: daysAgo(1) }, metrics: { conversions: 2, conversionsByConversionDate: 5, allConversions: 2, allConversionsByConversionDate: 5 } },
]) => (from: string, query: string): Row[] | undefined => {
  if (from === "conversion_action") return [{ conversionAction: { id: "501", name: "Compra" } }];
  if (/conversion_lag_bucket/.test(query)) return lagBucketRows();
  if (/segments\.date,|segments\.date\b.*FROM/s.test(query)) return daily;
  return undefined;
};
const lagRows = lagWorld();

test("get_conversion_lag: distribuição, limites de 50/90/95% e dias incompletos", async () => {
  const { client, calls } = fakeClient({ respond: lagRows });
  const result = await call(client, "get_conversion_lag", {});
  const body = jsonOf(result);
  assert.equal(body.basis, "conversions");
  assert.equal(body.total, 100, "UNKNOWN fica fora da distribuição");
  assert.deepEqual(body.threshold_days, { p50: 1, p90: 8, p95: 21 });
  assert.equal(body.incomplete_recent_days, 8);
  assert.deepEqual(body.recent_7_days, {
    from: daysAgo(7), to: daysAgo(1), calendar_days: 7, days_with_data: 2, by_interaction_date: 6, by_conversion_date: 11,
  });
  assert.match(textOf(result), /90% em até 8 dia/);
  assert.match(textOf(result), /últimos ~8 dia\(s\) ainda vão receber conversões/);
  // padrão 90 dias, FROM customer, sem filtro de campanha
  assert.ok(calls.queries.every((q) => !/FROM campaign/.test(q)));
  assert.match(calls.queries[0], /segments\.date BETWEEN/);
  assert.match(calls.queries[1], /metrics\.conversions_by_conversion_date/);
  assert.match(calls.queries[1], /ORDER BY segments\.date/);
});

test("get_conversion_lag: 'últimos 7 dias' são dias do calendário, não as 7 últimas linhas com dados", async () => {
  // Conta de lead gen: o GAQL omite dias sem conversão, então as 7 últimas linhas cobrem ~2,5 meses.
  const sparse = ["2026-06-30", "2026-07-10", "2026-07-20", "2026-08-01", "2026-08-10", "2026-08-20", "2026-09-01", "2026-09-21"].map((date) => ({
    segments: { date }, metrics: { conversions: 1, conversionsByConversionDate: 1, allConversions: 1, allConversionsByConversionDate: 1 },
  }));
  const { client } = fakeClient({ respond: lagWorld(sparse) });
  const result = await call(client, "get_conversion_lag", { dateRange: { since: "2026-06-01", until: "2026-09-21" } });
  const body = jsonOf(result);
  assert.deepEqual(body.recent_7_days, {
    from: "2026-09-15", to: "2026-09-21", calendar_days: 7, days_with_data: 1, by_interaction_date: 1, by_conversion_date: 1,
  });
  assert.match(textOf(result), /Últimos 7 dia\(s\) do período \(2026-09-15 a 2026-09-21; 1 com conversões\): 1 pela data da interação × 1 pela data da conversão/);
  assert.equal((body.daily as Row[]).length, 8, "o detalhe diário continua com todas as linhas");

  // Janela menor que 7 dias: o trecho recente não passa do início do período.
  const short = fakeClient({ respond: lagWorld(sparse) });
  const shortBody = jsonOf(await call(short.client, "get_conversion_lag", { dateRange: { since: "2026-09-19", until: "2026-09-21" } }));
  assert.deepEqual(shortBody.recent_7_days, {
    from: "2026-09-19", to: "2026-09-21", calendar_days: 3, days_with_data: 1, by_interaction_date: 1, by_conversion_date: 1,
  });

  // DURING LAST_30_DAYS termina ontem: o trecho recente vai de 7 dias atrás a ontem.
  const during = fakeClient({ respond: lagWorld([
    { segments: { date: daysAgo(20) }, metrics: { conversions: 5, conversionsByConversionDate: 5 } },
    { segments: { date: daysAgo(3) }, metrics: { conversions: 2, conversionsByConversionDate: 4 } },
  ]) });
  const duringResult = await call(during.client, "get_conversion_lag", { days: 30 });
  assert.match(during.calls.queries[0], /DURING LAST_30_DAYS/);
  assert.deepEqual(jsonOf(duringResult).recent_7_days, {
    from: daysAgo(7), to: daysAgo(1), calendar_days: 7, days_with_data: 1, by_interaction_date: 2, by_conversion_date: 4,
  });
});

test("get_conversion_lag: campanha usa FROM campaign; ação entra no SELECT e no WHERE e é conferida antes", async () => {
  const { client, calls } = fakeClient({ respond: lagRows });
  await call(client, "get_conversion_lag", { campaignId: "11", conversionActionId: "501", days: 30 });
  assert.match(calls.queries[0], /FROM conversion_action WHERE conversion_action\.id = 501/);
  for (const query of calls.queries.slice(1)) {
    assert.match(query, /FROM campaign/);
    assert.match(query, /campaign\.id = 11/);
    assert.match(query, /SELECT [^]*segments\.conversion_action[^]*FROM/);
    assert.match(query, new RegExp(`segments\\.conversion_action = 'customers/${CID}/conversionActions/501'`));
  }

  const missing = fakeClient();
  const result = await call(missing.client, "get_conversion_lag", { conversionActionId: "999" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não encontrada/);
  assert.equal(missing.calls.queries.length, 1);
});

test("get_conversion_lag: ação secundária usa Todas as conversões; sem dados não inventa limite", async () => {
  const secondary = fakeClient({
    respond: (from, query) => (from === "conversion_action" ? [{ conversionAction: { id: "7", name: "Lead" } }]
      : /conversion_lag_bucket/.test(query) ? [{ segments: { conversionLagBucket: "TWO_TO_THREE_DAYS" }, metrics: { conversions: 0, allConversions: 9 } }] : []),
  });
  const body = jsonOf(await call(secondary.client, "get_conversion_lag", { conversionActionId: "7" }));
  assert.equal(body.basis, "all_conversions");
  assert.deepEqual(body.threshold_days, { p50: 3, p90: 3, p95: 3 });

  const empty = fakeClient();
  const result = await call(empty.client, "get_conversion_lag", {});
  assert.match(textOf(result), /Sem conversões no período/);
  assert.equal(jsonOf(result).incomplete_recent_days, null);
});

test("get_conversion_lag: IDs inválidos são recusados sem consulta", async () => {
  const { client, calls } = fakeClient();
  assert.equal((await call(client, "get_conversion_lag", { conversionActionId: "abc" })).isError, true);
  assert.equal((await call(client, "get_conversion_lag", { campaignId: "1;2" })).isError, true);
  assert.equal(calls.queries.length, 0);
});

// ── Regras de valor: dados ───────────────────────────────────────────

const GEO_SP = "9001";
const GEO_RJ = "9002";
const rule = (id: string, over: Row = {}): Row => ({
  conversionValueRule: {
    id, resourceName: `customers/${CID}/conversionValueRules/${id}`, status: "ENABLED", ownerCustomer: `customers/${CID}`,
    action: { operation: "MULTIPLY", value: 1.5 },
    geoLocationCondition: { geoTargetConstants: [`geoTargetConstants/${GEO_SP}`], geoMatchType: "ANY" },
    ...over,
  },
});
const ruleSet = (id: string, rules: string[], over: Row = {}): Row => ({
  conversionValueRuleSet: {
    id, resourceName: `customers/${CID}/conversionValueRuleSets/${id}`, status: "ENABLED", ownerCustomer: `customers/${CID}`,
    dimensions: ["GEO_LOCATION"], attachmentType: "CUSTOMER",
    conversionValueRules: rules.map((r) => `customers/${CID}/conversionValueRules/${r}`),
    ...over,
  },
});

interface RuleWorld {
  rules?: Row[];
  sets?: Row[];
  campaign?: Row | null;
  geo?: string[];
  userLists?: string[];
}

function ruleWorld(world: RuleWorld) {
  return (from: string, query: string): Row[] | undefined => {
    if (from === "conversion_value_rule") {
      const byId = /conversion_value_rule\.id = (\d+)/.exec(query)?.[1];
      const rows = world.rules ?? [];
      return byId ? rows.filter((r) => (r.conversionValueRule as Row).id === byId) : rows;
    }
    if (from === "conversion_value_rule_set") return world.sets ?? [];
    if (from === "geo_target_constant") {
      const known = world.geo ?? [GEO_SP, GEO_RJ];
      const asked = idsIn(query, "geo_target_constant.id");
      const byResource = idsIn(query, "geo_target_constant.resource_name");
      return known
        .filter((id) => asked.includes(id) || byResource.includes(`geoTargetConstants/${id}`))
        .map((id) => ({ geoTargetConstant: { id, resourceName: `geoTargetConstants/${id}`, canonicalName: id === GEO_SP ? "Sao Paulo,Brazil" : "Rio de Janeiro,Brazil", status: "ENABLED" } }));
    }
    if (from === "user_list") {
      const known = world.userLists ?? ["301"];
      const asked = [...idsIn(query, "user_list.id"), ...idsIn(query, "user_list.resource_name").map((rn) => rn.split("/").pop()!)];
      return known.filter((id) => asked.includes(id)).map((id) => ({ userList: { id, resourceName: `customers/${CID}/userLists/${id}`, name: "Compradores 180d" } }));
    }
    if (from === "campaign") {
      if (world.campaign === null) return [];
      return [{ campaign: world.campaign ?? { id: "11", name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH", resourceName: `customers/${CID}/campaigns/11` } }];
    }
    return undefined;
  };
}

const onlyWrite = (calls: { writes: Write[] }) => {
  assert.equal(calls.writes.length, 1, "exatamente uma escrita");
  return calls.writes[0];
};

// ── list_conversion_value_rules ──────────────────────────────────────

test("list_conversion_value_rules: conjuntos em ordem, nomes resolvidos, regra fora de conjunto e herança", async () => {
  const { client, calls } = fakeClient({
    respond: ruleWorld({
      rules: [
        rule("1"),
        rule("2", { action: { operation: "ADD", value: 30 }, geoLocationCondition: undefined, audienceCondition: { userLists: [`customers/${CID}/userLists/301`] } }),
        rule("3", { status: "PAUSED", deviceCondition: { deviceTypes: ["MOBILE"] }, geoLocationCondition: undefined }),
      ],
      sets: [
        ruleSet("50", ["2", "1"], { dimensions: ["GEO_LOCATION", "AUDIENCE"] }),
        ruleSet("51", ["9"], { attachmentType: "CAMPAIGN", campaign: `customers/${CID}/campaigns/11`, ownerCustomer: "customers/5555555555", dimensions: ["DEVICE"] }),
      ],
    }),
  });
  const result = await call(client, "list_conversion_value_rules", {});
  const body = jsonOf(result);
  const sets = body.rule_sets as Row[];
  assert.equal(sets[0].primary_dimension, "GEO_LOCATION");
  const ordered = sets[0].rules as Row[];
  assert.deepEqual(ordered.map((r) => r.rule_id), ["2", "1"], "a ordem do conjunto é a de avaliação");
  assert.match(String(ordered[0].action), /somar R\$ 30\.00/);
  assert.match(String((ordered[0].conditions as string[])[0]), /Compradores 180d \(301\)/);
  assert.match(String((ordered[1].conditions as string[])[0]), /Sao Paulo,Brazil \(9001\) \[ANY\]/);
  assert.equal(sets[1].inherited_from, "customers/5555555555");
  assert.match(String(sets[1].scope), /campanha Pesquisa \(11\)/);
  assert.deepEqual((body.rules_outside_sets as Row[]).map((r) => r.rule_id), ["3"]);
  assert.match(textOf(result), /1 regra\(s\) fora de conjunto — não são aplicadas/);
  assert.match(calls.queries[0], /WHERE conversion_value_rule\.status != 'REMOVED'/);
  assert.ok(calls.queries.some((q) => /FROM geo_target_constant/.test(q)));
  assert.ok(calls.queries.some((q) => /FROM user_list/.test(q)));
  assert.ok(calls.queries.some((q) => /FROM campaign WHERE campaign\.resource_name IN/.test(q)));
});

// ── create_conversion_value_rule ─────────────────────────────────────

test("create_conversion_value_rule: sem conjunto na conta cria regra e conjunto numa operação atômica", async () => {
  const { client, calls } = fakeClient({ respond: ruleWorld({}) });
  const result = await call(client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 1.3, geoTargetConstantIds: [GEO_SP] });
  assert.equal(result.isError, undefined, textOf(result));
  const write = onlyWrite(calls);
  assert.equal(write.method, "batchMutate");
  const [ruleOp, setOp] = write.operations as Row[];
  const created = (ruleOp.conversionValueRuleOperation as Row).create as Row;
  assert.equal(created.resourceName, `customers/${CID}/conversionValueRules/-1`);
  assert.deepEqual(created.action, { operation: "MULTIPLY", value: 1.3 });
  assert.deepEqual(created.geoLocationCondition, { geoTargetConstants: [`geoTargetConstants/${GEO_SP}`], geoMatchType: "ANY" });
  assert.equal(created.status, "ENABLED");
  const set = (setOp.conversionValueRuleSetOperation as Row).create as Row;
  assert.equal(set.resourceName, `customers/${CID}/conversionValueRuleSets/-2`);
  assert.deepEqual(set.conversionValueRules, [created.resourceName], "o conjunto referencia o ID temporário");
  assert.deepEqual(set.dimensions, ["GEO_LOCATION"]);
  assert.equal(set.attachmentType, "CUSTOMER");
  assert.equal(set.campaign, undefined);
  assert.match(textOf(result), /Regra de valor criada/);
  assert.match(textOf(result), /multiplicar o valor da conversão por 1\.3/);
  assert.match(textOf(result), /Conjunto novo \(conta inteira\)/);
});

test("create_conversion_value_rule: conjunto existente recebe a regra no fim e a dimensão nova é acrescentada", async () => {
  const { client, calls } = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }) });
  const result = await call(client, "create_conversion_value_rule", { operation: "ADD", value: 25, deviceTypes: ["MOBILE", "TABLET"] });
  const write = onlyWrite(calls);
  const update = (write.operations[1].conversionValueRuleSetOperation as Row);
  assert.equal(update.updateMask, "conversion_value_rules,dimensions");
  const body = update.update as Row;
  assert.deepEqual(body.conversionValueRules, [`customers/${CID}/conversionValueRules/1`, `customers/${CID}/conversionValueRules/-1`]);
  assert.deepEqual(body.dimensions, ["GEO_LOCATION", "DEVICE"], "só acrescenta, nunca troca a ordem");
  assert.deepEqual(((write.operations[0].conversionValueRuleOperation as Row).create as Row).deviceCondition, { deviceTypes: ["MOBILE", "TABLET"] });
  assert.match(textOf(result), /regras 1 → 2 \(a nova é a 2ª na ordem\); dimensões GEO_LOCATION → GEO_LOCATION, DEVICE/);

  // Dimensão que já existe: updateMask só da lista de regras.
  const same = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }) });
  await call(same.client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 0.8, geoTargetConstantIds: [GEO_RJ] });
  assert.equal((onlyWrite(same.calls).operations[1].conversionValueRuleSetOperation as Row).updateMask, "conversion_value_rules");
});

test("create_conversion_value_rule: conjunto por campanha só em Pesquisa/Display e com campanha existente", async () => {
  const ok = fakeClient({ respond: ruleWorld({ userLists: ["301"] }) });
  await call(ok.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, userListIds: ["301"] });
  const set = ((onlyWrite(ok.calls).operations[1].conversionValueRuleSetOperation as Row).create as Row);
  assert.equal(set.attachmentType, "CAMPAIGN");
  assert.equal(set.campaign, `customers/${CID}/campaigns/11`);
  assert.deepEqual(set.dimensions, ["AUDIENCE"]);

  const pmax = fakeClient({ respond: ruleWorld({ campaign: { id: "11", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" } }) });
  const refused = await call(pmax.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, geoTargetConstantIds: [GEO_SP] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /só existe em Pesquisa e Display/);
  assert.equal(pmax.calls.writes.length, 0);

  const gone = fakeClient({ respond: ruleWorld({ campaign: null }) });
  const missing = await call(gone.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, geoTargetConstantIds: [GEO_SP] });
  assert.match(textOf(missing), /não encontrada/);
  assert.equal(gone.calls.writes.length, 0);
});

test("create_conversion_value_rule: entrada inválida é recusada antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient({ respond: ruleWorld({}) });
  const cases: Array<[Row, RegExp]> = [
    [{ operation: "MULTIPLY", value: 20, geoTargetConstantIds: [GEO_SP] }, /entre 0,5 e 10/],
    [{ operation: "MULTIPLY", value: 0.4, geoTargetConstantIds: [GEO_SP] }, /entre 0,5 e 10/],
    [{ operation: "ADD", value: 0, geoTargetConstantIds: [GEO_SP] }, /maior que 0/],
    [{ operation: "SET", value: -5, deviceTypes: ["MOBILE"] }, /maior que 0/],
    [{ operation: "ADD", value: 5 }, /ao menos uma condição/],
    [{ operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP], deviceTypes: ["MOBILE"], userListIds: ["301"] }, /no máximo 2 tipos/],
    [{ operation: "ADD", value: 5, geoTargetConstantIds: ["São Paulo"] }, /IDs numéricos/],
    [{ operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP], excludedGeoTargetConstantIds: [GEO_SP] }, /incluído e excluído/],
    [{ operation: "ADD", value: 5, deviceTypes: ["SMART_TV"] }, /deviceTypes inválido/],
    [{ operation: "ADD", value: 5, deviceTypes: ["MOBILE"], primaryDimension: "AUDIENCE" }, /primaryDimension/],
    [{ operation: "ADD", value: 5, deviceTypes: ["MOBILE"], geoMatchType: "ANY" }, /geoMatchType sem/],
    [{ operation: "ADD", value: 5, deviceTypes: ["MOBILE"], campaignId: "11 OR 1=1" }, /numérico/],
  ];
  for (const [args, message] of cases) {
    const result = await call(client, "create_conversion_value_rule", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), message);
  }
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.writes.length, 0);
});

test("create_conversion_value_rule: regra idêntica é no-op; mesma condição com outra ação é conflito", async () => {
  const world = ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] });
  const noop = fakeClient({ respond: world });
  const same = await call(noop.client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 1.5, geoTargetConstantIds: [GEO_SP] });
  assert.equal(same.isError, undefined);
  assert.match(textOf(same), /Nada a fazer/);
  assert.equal(noop.calls.writes.length, 0);

  const conflict = fakeClient({ respond: world });
  const other = await call(conflict.client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 2, geoTargetConstantIds: [GEO_SP] });
  assert.equal(other.isError, true);
  assert.match(textOf(other), /Já existe a regra 1/);
  assert.equal(conflict.calls.writes.length, 0);

  // Pausada com a mesma ação: não reativa sozinha.
  const paused = fakeClient({ respond: ruleWorld({ rules: [rule("1", { status: "PAUSED" })], sets: [ruleSet("50", ["1"])] }) });
  const reply = await call(paused.client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 1.5, geoTargetConstantIds: [GEO_SP] });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /PAUSED[^]*update_conversion_value_rule/);
  assert.equal(paused.calls.writes.length, 0);
});

test("create_conversion_value_rule: só o tipo de correspondência de local diferente NÃO é no-op — aponta o update com geoMatchType", async () => {
  const world = ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }); // regra 1: SP, ANY, MULTIPLY 1.5
  const presence = fakeClient({ respond: world });
  const result = await call(presence.client, "create_conversion_value_rule", {
    operation: "MULTIPLY", value: 1.5, geoTargetConstantIds: [GEO_SP], geoMatchType: "LOCATION_OF_PRESENCE",
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(textOf(result), /Nada a fazer/);
  assert.match(textOf(result), /correspondência dos locais incluídos: a regra usa ANY; o pedido é LOCATION_OF_PRESENCE/);
  assert.match(textOf(result), /update_conversion_value_rule com conversionValueRuleId "1" e geoMatchType: "LOCATION_OF_PRESENCE"/);
  assert.doesNotMatch(textOf(result), /ação:/, "a ação é igual — não aparece como diferença");
  assert.equal(presence.calls.writes.length, 0);

  // ANY explícito (= o que a regra já usa) continua no-op.
  const explicitAny = fakeClient({ respond: world });
  const same = await call(explicitAny.client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 1.5, geoTargetConstantIds: [GEO_SP], geoMatchType: "ANY" });
  assert.equal(same.isError, undefined);
  assert.match(textOf(same), /Nada a fazer/);
  assert.equal(explicitAny.calls.writes.length, 0);

  // Locais excluídos: a mesma regra, com correspondência dos excluídos diferente.
  const excludedWorld = ruleWorld({
    rules: [rule("1", { geoLocationCondition: { geoTargetConstants: [`geoTargetConstants/${GEO_SP}`], geoMatchType: "ANY", excludedGeoTargetConstants: [`geoTargetConstants/${GEO_RJ}`], excludedGeoMatchType: "ANY" } })],
    sets: [ruleSet("50", ["1"])],
  });
  const excluded = fakeClient({ respond: excludedWorld });
  const excludedResult = await call(excluded.client, "create_conversion_value_rule", {
    operation: "MULTIPLY", value: 1.5, geoTargetConstantIds: [GEO_SP], excludedGeoTargetConstantIds: [GEO_RJ], excludedGeoMatchType: "LOCATION_OF_PRESENCE",
  });
  assert.equal(excludedResult.isError, true);
  assert.match(textOf(excludedResult), /correspondência dos locais excluídos: a regra usa ANY; o pedido é LOCATION_OF_PRESENCE/);
  assert.match(textOf(excludedResult), /excludedGeoMatchType: "LOCATION_OF_PRESENCE"/);
  assert.equal(excluded.calls.writes.length, 0);

  // Ação e correspondência diferentes: as duas diferenças são listadas.
  const both = fakeClient({ respond: world });
  const bothResult = await call(both.client, "create_conversion_value_rule", {
    operation: "ADD", value: 10, geoTargetConstantIds: [GEO_SP], geoMatchType: "LOCATION_OF_PRESENCE",
  });
  assert.match(textOf(bothResult), /- ação: a regra faz "multiplicar o valor da conversão por 1\.5"; o pedido é "somar R\$ 10\.00/);
  assert.match(textOf(bothResult), /operation: "ADD", value: 10, geoMatchType: "LOCATION_OF_PRESENCE"/);
});

/** Conta com conjunto CUSTOMER 50: regra 1 (São Paulo ×1,5) e regra 2 (MOBILE +R$ 30). */
const accountRulesWorld = (over: RuleWorld = {}) => ruleWorld({
  rules: [rule("1"), rule("2", { action: { operation: "ADD", value: 30 }, geoLocationCondition: undefined, deviceCondition: { deviceTypes: ["MOBILE"] } })],
  sets: [ruleSet("50", ["1", "2"], { dimensions: ["GEO_LOCATION", "DEVICE"] })],
  ...over,
});

test("create_conversion_value_rule: 1º conjunto da campanha com regras ativas na conta exige confirm e lista o que deixa de valer", async () => {
  const refused = fakeClient({ respond: accountRulesWorld() });
  const result = await call(refused.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"] });
  assert.equal(result.isError, true);
  assert.equal(refused.calls.writes.length, 0, "nada é gravado sem confirm");
  const message = textOf(result);
  assert.match(message, /SÓ os conjuntos da campanha valem para ela/);
  assert.match(message, /- conjunto 50 \(conta inteira\):/);
  assert.match(message, /regra 1: se local: Sao Paulo,Brazil \(9001\) \[ANY\] → multiplicar o valor da conversão por 1\.5/);
  assert.match(message, /regra 2: se dispositivo: MOBILE → somar R\$ 30\.00/);
  assert.match(message, /confirm: true/);
  assert.match(message, /Nada foi enviado/);

  const confirmed = fakeClient({ respond: accountRulesWorld() });
  const ok = await call(confirmed.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"], confirm: true });
  assert.equal(ok.isError, undefined, textOf(ok));
  const set = (onlyWrite(confirmed.calls).operations[1].conversionValueRuleSetOperation as Row).create as Row;
  assert.equal(set.attachmentType, "CAMPAIGN");
  assert.match(textOf(ok), /Precedência: com conjunto próprio ativo, a campanha 11 passa a ignorar os conjuntos da conta — 2 regra\(s\) ativa\(s\) da conta deixam de valer para ela/);
  assert.match(textOf(ok), /conjunto 50 \(conta inteira\) regras 1, 2/);

  // validateOnly com confirm: valida, não grava, e fala no condicional.
  const dry = fakeClient({ respond: accountRulesWorld() });
  const validated = await call(dry.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"], confirm: true, validateOnly: true });
  assert.equal(onlyWrite(dry.calls).dryRun, true);
  assert.match(textOf(validated), /passaria a ignorar os conjuntos da conta — 2 regra\(s\) ativa\(s\) da conta deixariam de valer/);
});

test("create_conversion_value_rule: precedência — regras pausadas, conjunto herdado, campanha já com conjunto e escopo da conta", async () => {
  // Só regras pausadas na conta: nada deixa de valer hoje, sem confirm — mas o efeito é dito.
  const paused = fakeClient({
    respond: accountRulesWorld({
      rules: [rule("1", { status: "PAUSED" })],
      sets: [ruleSet("50", ["1"], { status: "PAUSED" })],
    }),
  });
  const pausedResult = await call(paused.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, geoTargetConstantIds: [GEO_RJ] });
  assert.equal(pausedResult.isError, undefined, textOf(pausedResult));
  assert.equal(paused.calls.writes.length, 1);
  assert.match(textOf(pausedResult), /passa a ignorar os conjuntos da conta \(hoje sem regras ativas\)/);

  // Conjunto da conta herdado da MCC também deixa de valer: entra na lista.
  const inherited = fakeClient({
    respond: accountRulesWorld({
      rules: [rule("7", { ownerCustomer: "customers/5555555555" })],
      sets: [ruleSet("60", ["7"], { ownerCustomer: "customers/5555555555" })],
    }),
  });
  const inheritedResult = await call(inherited.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"] });
  assert.equal(inheritedResult.isError, true);
  assert.match(textOf(inheritedResult), /conjunto 60 \(conta inteira, herdado de customers\/5555555555\)/);
  assert.equal(inherited.calls.writes.length, 0);

  // Campanha já tem conjunto próprio ativo: a precedência não muda, sem confirm.
  const scoped = fakeClient({
    respond: accountRulesWorld({
      rules: [rule("1"), rule("3", { geoLocationCondition: undefined, deviceCondition: { deviceTypes: ["TABLET"] } })],
      sets: [ruleSet("50", ["1"]), ruleSet("51", ["3"], { attachmentType: "CAMPAIGN", campaign: `customers/${CID}/campaigns/11`, dimensions: ["DEVICE"] })],
    }),
  });
  const scopedResult = await call(scoped.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"] });
  assert.equal(scopedResult.isError, undefined, textOf(scopedResult));
  assert.equal(((onlyWrite(scoped.calls).operations[1].conversionValueRuleSetOperation as Row).update as Row).resourceName, `customers/${CID}/conversionValueRuleSets/51`);
  assert.match(textOf(scopedResult), /já tem conjunto próprio ativo, então os conjuntos da conta já não valem para ela/);

  // Conjunto da campanha existe mas está PAUSED (todas as regras pausadas): a regra nova o reativa e
  // as regras ativas da conta deixam de valer — mesmo portão de confirm.
  const pausedCampaignSet = fakeClient({
    respond: accountRulesWorld({
      rules: [rule("1"), rule("3", { status: "PAUSED", geoLocationCondition: undefined, deviceCondition: { deviceTypes: ["TABLET"] } })],
      sets: [ruleSet("50", ["1"]), ruleSet("51", ["3"], { status: "PAUSED", attachmentType: "CAMPAIGN", campaign: `customers/${CID}/campaigns/11`, dimensions: ["DEVICE"] })],
    }),
  });
  const pausedSetResult = await call(pausedCampaignSet.client, "create_conversion_value_rule", { campaignId: "11", operation: "ADD", value: 10, deviceTypes: ["DESKTOP"] });
  assert.equal(pausedSetResult.isError, true);
  assert.match(textOf(pausedSetResult), /ainda não tem conjunto de regras próprio ativo[^]*regra 1: se local: Sao Paulo/);
  assert.equal(pausedCampaignSet.calls.writes.length, 0);

  // Sem campaignId: avisa quais campanhas têm conjunto próprio e não recebem a regra da conta.
  const account = fakeClient({
    respond: accountRulesWorld({
      rules: [rule("1"), rule("3", { geoLocationCondition: undefined, deviceCondition: { deviceTypes: ["TABLET"] } })],
      sets: [ruleSet("50", ["1"], { dimensions: ["GEO_LOCATION", "DEVICE"] }), ruleSet("51", ["3"], { attachmentType: "CAMPAIGN", campaign: `customers/${CID}/campaigns/11`, dimensions: ["DEVICE"] })],
    }),
  });
  const accountResult = await call(account.client, "create_conversion_value_rule", { operation: "ADD", value: 10, deviceTypes: ["DESKTOP"] });
  assert.equal(accountResult.isError, undefined, textOf(accountResult));
  assert.match(textOf(accountResult), /1 campanha\(s\) com conjunto próprio ativo \(11\) ignoram o conjunto da conta e não recebem esta regra/);
});

test("create_conversion_value_rule: conjunto herdado, dimensões esgotadas e local inexistente não gravam", async () => {
  const inherited = fakeClient({ respond: ruleWorld({ sets: [ruleSet("50", ["1"], { ownerCustomer: "customers/5555555555" })] }) });
  const r1 = await call(inherited.client, "create_conversion_value_rule", { operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP] });
  assert.match(textOf(r1), /herdado de customers\/5555555555/);

  const full = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"], { dimensions: ["GEO_LOCATION", "DEVICE"] })] }) });
  const r2 = await call(full.client, "create_conversion_value_rule", { operation: "ADD", value: 5, userListIds: ["301"] });
  assert.match(textOf(r2), /no máximo 2 e só permite acrescentar/);

  const unknownGeo = fakeClient({ respond: ruleWorld({ geo: [] }) });
  const r3 = await call(unknownGeo.client, "create_conversion_value_rule", { operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP] });
  assert.match(textOf(r3), /inexistente/);

  const unknownList = fakeClient({ respond: ruleWorld({ userLists: [] }) });
  const r4 = await call(unknownList.client, "create_conversion_value_rule", { operation: "ADD", value: 5, userListIds: ["301"] });
  assert.match(textOf(r4), /não encontrada/);

  for (const { calls } of [inherited, full, unknownGeo, unknownList]) assert.equal(calls.writes.length, 0);
});

test("create_conversion_value_rule: erro da API vira explicação e 'nada foi gravado'", async () => {
  const { client } = fakeClient({
    respond: ruleWorld({}),
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The value rule set is attached to a campaign that does not support value rules."); },
  });
  const result = await call(client, "create_conversion_value_rule", { operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi gravado \(operação atômica\)/);
  assert.match(textOf(result), /só em campanhas de Pesquisa ou Display/);
});

test("create_conversion_value_rule: validateOnly roda num client em dry-run e não diz que gravou", async () => {
  const { client, calls } = fakeClient({ respond: ruleWorld({}) });
  const result = await call(client, "create_conversion_value_rule", { operation: "ADD", value: 5, geoTargetConstantIds: [GEO_SP], validateOnly: true });
  assert.equal(onlyWrite(calls).dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /nada foi gravado/);
  assert.doesNotMatch(textOf(result), /Regra de valor criada/);
});

// ── update_conversion_value_rule ─────────────────────────────────────

test("update_conversion_value_rule: muda só o valor — updateMask com a folha action.value", async () => {
  const { client, calls } = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }) });
  const result = await call(client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 2 });
  const write = onlyWrite(calls);
  assert.equal(write.method, "mutate:conversionValueRules");
  const op = write.operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "action.value");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/conversionValueRules/1`, action: { value: 2 } });
  assert.match(textOf(result), /multiplicar o valor da conversão por 1\.5 → multiplicar o valor da conversão por 2/);
  for (const path of op.updateMask.split(",")) assert.ok(!["action", "geo_location_condition", "device_condition", "audience_condition"].includes(path));
});

test("update_conversion_value_rule: nada muda = sem escrita; faixa checada com a operação atual", async () => {
  const world = ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] });
  const noop = fakeClient({ respond: world });
  const same = await call(noop.client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 1.5, status: "ENABLED", geoTargetConstantIds: [GEO_SP] });
  assert.match(textOf(same), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const range = fakeClient({ respond: world });
  const bad = await call(range.client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 20 });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /MULTIPLY exige value entre 0,5 e 10/);
  assert.equal(range.calls.writes.length, 0);
});

test("update_conversion_value_rule: pausa e troca de condição dentro das dimensões do conjunto", async () => {
  const world = ruleWorld({ rules: [rule("1"), rule("2", { geoLocationCondition: { geoTargetConstants: [`geoTargetConstants/${GEO_RJ}`], geoMatchType: "ANY" } })], sets: [ruleSet("50", ["1", "2"], { dimensions: ["GEO_LOCATION", "DEVICE"] })] });
  const pause = fakeClient({ respond: world });
  await call(pause.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "PAUSED" });
  assert.equal((onlyWrite(pause.calls).operations[0] as Row).updateMask, "status");

  const devices = fakeClient({ respond: world });
  await call(devices.client, "update_conversion_value_rule", { conversionValueRuleId: "1", deviceTypes: ["DESKTOP"] });
  const op = onlyWrite(devices.calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "device_condition.device_types");
  assert.deepEqual(op.update.deviceCondition, { deviceTypes: ["DESKTOP"] });

  const audience = fakeClient({ respond: world });
  const outside = await call(audience.client, "update_conversion_value_rule", { conversionValueRuleId: "1", userListIds: ["301"] });
  assert.match(textOf(outside), /só aceita condições de GEO_LOCATION, DEVICE/);
  assert.equal(audience.calls.writes.length, 0);

  const clash = fakeClient({ respond: world });
  const dup = await call(clash.client, "update_conversion_value_rule", { conversionValueRuleId: "1", geoTargetConstantIds: [GEO_RJ] });
  assert.match(textOf(dup), /A regra 2 do mesmo conjunto já tem essas condições/);
  assert.equal(clash.calls.writes.length, 0);
});

test("update_conversion_value_rule: remover exige confirm e tira a regra do conjunto na mesma operação", async () => {
  const world = ruleWorld({ rules: [rule("1"), rule("2")], sets: [ruleSet("50", ["1", "2"])] });
  const noConfirm = fakeClient({ respond: world });
  const refused = await call(noConfirm.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "REMOVED" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(noConfirm.calls.queries.length, 0);

  const mixed = fakeClient({ respond: world });
  assert.equal((await call(mixed.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "REMOVED", value: 2, confirm: true })).isError, true);
  assert.equal(mixed.calls.queries.length, 0);

  const ok = fakeClient({ respond: world });
  const result = await call(ok.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "REMOVED", confirm: true });
  const write = onlyWrite(ok.calls);
  assert.equal(write.method, "batchMutate");
  const [setOp, ruleOp] = write.operations as Row[];
  assert.deepEqual(setOp.conversionValueRuleSetOperation, {
    update: { resourceName: `customers/${CID}/conversionValueRuleSets/50`, conversionValueRules: [`customers/${CID}/conversionValueRules/2`] },
    updateMask: "conversion_value_rules",
  });
  assert.deepEqual(ruleOp.conversionValueRuleOperation, { remove: `customers/${CID}/conversionValueRules/1` });
  assert.match(textOf(result), /Regra 1 removida/);
});

test("update_conversion_value_rule: última regra do conjunto só sai com removeRuleSetIfEmpty (e o conjunto vai junto)", async () => {
  const world = ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] });
  const blocked = fakeClient({ respond: world });
  const refused = await call(blocked.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "REMOVED", confirm: true });
  assert.match(textOf(refused), /única do conjunto 50/);
  assert.equal(blocked.calls.writes.length, 0);

  const both = fakeClient({ respond: world });
  await call(both.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "REMOVED", confirm: true, removeRuleSetIfEmpty: true });
  const ops = onlyWrite(both.calls).operations as Row[];
  assert.deepEqual(ops, [
    { conversionValueRuleSetOperation: { remove: `customers/${CID}/conversionValueRuleSets/50` } },
    { conversionValueRuleOperation: { remove: `customers/${CID}/conversionValueRules/1` } },
  ]);
});

test("update_conversion_value_rule: inexistente, herdada e erro da API", async () => {
  const missing = fakeClient({ respond: ruleWorld({ rules: [] }) });
  assert.match(textOf(await call(missing.client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 2 })), /não encontrada/);

  const inherited = fakeClient({ respond: ruleWorld({ rules: [rule("1", { ownerCustomer: "customers/5555555555" })] }) });
  assert.match(textOf(await call(inherited.client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 2 })), /herdada/);

  const apiError = fakeClient({
    respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }),
    // Como o GoogleAdsClient real monta a mensagem: só errors[].message (texto do proto), sem o errorCode.
    mutate: () => { throw new Error(`Google Ads API: Request contains an invalid argument. — ${API_MESSAGES.CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED}`); },
  });
  const result = await call(apiError.client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "PAUSED" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi gravado/);
  assert.match(textOf(result), /pausados juntos/);
  assert.equal(missing.calls.writes.length + inherited.calls.writes.length, 0);
  assert.equal((await call(missing.client, "update_conversion_value_rule", { conversionValueRuleId: "1 OR 1=1" })).isError, true);
});

// ── get_value_rule_impact ────────────────────────────────────────────

test("get_value_rule_impact: valor original × ajustado por campanha e quebra por dimensão primária", async () => {
  const { client, calls } = fakeClient({
    respond: (from, query) => {
      if (/conversion_value_rule_primary_dimension/.test(query)) {
        return [
          { segments: { conversionValueRulePrimaryDimension: "NO_RULE_APPLIED" }, metrics: { conversionsValue: 800, allConversionsValue: 900 } },
          { segments: { conversionValueRulePrimaryDimension: "ORIGINAL" }, metrics: { conversionsValue: 200, allConversionsValue: 200 } },
          { segments: { conversionValueRulePrimaryDimension: "GEO_LOCATION" }, metrics: { conversionsValue: 100, allConversionsValue: 100 } },
        ];
      }
      if (from === "campaign") {
        return [
          { campaign: { id: "11", name: "Pesquisa SP" }, metrics: { conversions: 10, conversionsValue: 1100, originalConversionValue: 1000 } },
          { campaign: { id: "12", name: "Pesquisa RJ" }, metrics: { conversions: 3, conversionsValue: 300, originalConversionValue: 300 } },
        ];
      }
      if (from === "conversion_value_rule_set") return [ruleSet("50", ["1"])];
      return undefined;
    },
  });
  const result = await call(client, "get_value_rule_impact", { days: 30 });
  const body = jsonOf(result);
  assert.deepEqual(body.totals, { original_value: 1300, adjusted_value: 1400, adjustment: 100 });
  const top = (body.campaigns as Row[])[0];
  assert.equal(top.campaign_id, "11");
  assert.equal(top.adjustment_pct, 10);
  assert.match(String((body.by_primary_dimension as Row[]).find((d) => d.dimension === "ORIGINAL")!.meaning), /^valor original \(antes da regra\)/);
  assert.match(textOf(result), /diferença \+R\$ 100\.00 \(\+7\.69%\)/);
  const dimensionQuery = calls.queries.find((q) => /primary_dimension/.test(q))!;
  assert.match(dimensionQuery, /FROM customer/);
  assert.doesNotMatch(dimensionQuery, /original_conversion_value/);

  const one = fakeClient();
  await call(one.client, "get_value_rule_impact", { campaignId: "11" });
  assert.ok(one.calls.queries.filter((q) => /metrics\./.test(q)).every((q) => /FROM campaign/.test(q) && /campaign\.id = 11/.test(q)));
  assert.equal((await call(one.client, "get_value_rule_impact", { campaignId: "x" })).isError, true);
});

test("get_value_rule_impact: linha de dimensão é o valor DEPOIS da regra; o ajuste é dimensões − ORIGINAL", async () => {
  // Guia "Conversion value rules" (Metrics): GEO_LOCATION/DEVICE/AUDIENCE = "value of conversions after a rule was applied".
  const { client } = fakeClient({
    respond: (_from, query) => (/conversion_value_rule_primary_dimension/.test(query)
      ? [
        { segments: { conversionValueRulePrimaryDimension: "NO_RULE_APPLIED" }, metrics: { conversionsValue: 300, allConversionsValue: 300 } },
        { segments: { conversionValueRulePrimaryDimension: "ORIGINAL" }, metrics: { conversionsValue: 1000, allConversionsValue: 1100 } },
        { segments: { conversionValueRulePrimaryDimension: "GEO_LOCATION" }, metrics: { conversionsValue: 1200, allConversionsValue: 1300 } },
        { segments: { conversionValueRulePrimaryDimension: "DEVICE" }, metrics: { conversionsValue: 300, allConversionsValue: 350 } },
      ]
      : undefined),
  });
  const result = await call(client, "get_value_rule_impact", {});
  const body = jsonOf(result);
  const geo = (body.by_primary_dimension as Row[]).find((d) => d.dimension === "GEO_LOCATION")!;
  assert.equal(geo.conversions_value, 1200);
  assert.match(String(geo.meaning), /^valor depois da regra/);
  assert.doesNotMatch(String(geo.meaning), /ajuste/, "a linha da dimensão não é o ajuste");
  assert.deepEqual(body.rule_effect, {
    conversions_value: { original_value: 1000, value_after_rules: 1500, adjustment: 500 },
    all_conversions_value: { original_value: 1100, value_after_rules: 1650, adjustment: 550 },
  });
  assert.match(textOf(result), /valor original R\$ 1000\.00 → R\$ 1500\.00 depois das regras \(ajuste \+R\$ 500\.00\)/);
  assert.match(textOf(result), /são o valor DEPOIS da regra, não o ajuste/);

  const table = textOf(await call(client, "get_value_rule_impact", { format: "table" }));
  assert.match(table, /valor depois da regra/);
});

// ── get_lift_results ─────────────────────────────────────────────────

const liftConfig = (id: string, over: Row = {}): Row => ({
  liftMeasurementConfig: { liftMeasurementConfigId: id, name: `Estudo ${id}`, campaigns: [`customers/${CID}/campaigns/11`], conversionActions: [], ...over },
});
const flight = (configId: string, liftType: string): Row => ({
  liftMeasurementFlight: { liftMeasurementConfigId: configId, liftMeasurementFlightId: "1", name: "Voo 1", status: "ENABLED", liftType, startDate: "2026-08-01", endDate: "2026-08-28" },
});

/** Como a API real: SELECT com lift_measurement_config.campaigns responde "Internal error encountered." */
const campaignsFieldBreaks = (query: string) => {
  if (/lift_measurement_config\.campaigns/.test(query)) throw new Error("Google Ads API: Internal error encountered.");
};

test("get_lift_results: sem estudos responde sem erro e sem consultar resultados", async () => {
  const { client, calls } = fakeClient({ respond: (_from, query) => { campaignsFieldBreaks(query); return undefined; } });
  const result = await call(client, "get_lift_results", {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Nenhum estudo de lift/);
  assert.equal(calls.queries.length, 1);

  const missing = await call(client, "get_lift_results", { liftMeasurementConfigId: "77" });
  assert.equal(missing.isError, true);
});

test("get_lift_results: se a API falhar ao ler as campanhas dos estudos, o resto sai com campaigns null e nota", async () => {
  const { client } = fakeClient({
    respond: (from, query) => {
      campaignsFieldBreaks(query);
      if (from === "lift_measurement_flight") return [flight("77", "CONVERSION")];
      if (from === "lift_measurement_config" && /metrics\./.test(query)) return [];
      if (from === "lift_measurement_config") return [liftConfig("77")];
      return undefined;
    },
  });
  const result = await call(client, "get_lift_results", {});
  assert.equal(result.isError, undefined, textOf(result));
  const [study] = jsonOf(result).studies as Row[];
  assert.equal(study.config_id, "77");
  assert.equal(study.campaigns, null, "null = a API não devolveu (≠ estudo sem campanha)");
  assert.equal((study.flights as Row[]).length, 1);
  assert.match(textOf(result), /Campanhas dos estudos indisponíveis \(campaigns: null\) — a API falhou ao lê-las: Google Ads API: Internal error encountered\./);
});

test("get_lift_results: Conversion Lift com intervalo acima de zero vira 'positivo e significativo'", async () => {
  const { client, calls } = fakeClient({
    respond: (from, query) => {
      if (from === "lift_measurement_flight") return [flight("77", "CONVERSION")];
      if (from === "campaign") return [{ campaign: { resourceName: `customers/${CID}/campaigns/11`, name: "Pesquisa" } }];
      if (from === "lift_measurement_config" && /metrics\./.test(query)) {
        return [{
          liftMeasurementConfig: { liftMeasurementConfigId: "77", name: "Estudo 77" },
          segments: { conversionLiftStartDate: "20260801", conversionLiftEndDate: "20260828", conversionLiftConversionCategory: "PURCHASE" },
          metrics: {
            incrementalConversions: 120, incrementalConversionsP90LowerBound: 40, incrementalConversionsP90UpperBound: 200,
            incrementalConversionsPValue: 0.03, costPerIncrementalConversion: 55, relativeConversionLift: 0.18,
          },
        }];
      }
      if (from === "lift_measurement_config") return [liftConfig("77", { conversionActions: [`customers/${CID}/conversionActions/501`] })];
      return undefined;
    },
  });
  const result = await call(client, "get_lift_results", { liftMeasurementConfigId: "77" });
  const body = jsonOf(result);
  const row = (body.conversion_lift as Row[])[0];
  assert.match(String(row.verdict), /^positivo e significativo a 90%/);
  assert.equal(row.significant_90, true);
  assert.equal(row.incremental_conversions, 120);
  assert.equal(row.relative_conversion_lift, 0.18, "valor como a API devolve");
  assert.deepEqual((body.studies as Row[])[0].campaigns, ["Pesquisa (11)"]);
  assert.match(textOf(result), /120 conversões incrementais → positivo/);
  assert.deepEqual(body.brand_lift, [], "estudo de conversão não consulta Brand Lift");
  const results = calls.queries.find((q) => /metrics\.incremental_conversions/.test(q))!;
  assert.match(results, /metrics\.incremental_conversions_winner_score/);
  assert.match(results, /lift_measurement_config\.lift_measurement_config_id = 77/);
  assert.ok(!calls.queries.some((q) => /brand_lift/.test(q)));
});

test("get_lift_results: breakdown por idade tira winner score; intervalo com zero é inconclusivo", async () => {
  const { client, calls } = fakeClient({
    respond: (from, query) => {
      if (from === "lift_measurement_flight") return [flight("77", "CONVERSION")];
      if (from === "lift_measurement_config" && /metrics\./.test(query)) {
        return [{
          liftMeasurementConfig: { liftMeasurementConfigId: "77" }, segments: { ageRange: "AGE_RANGE_25_34" },
          metrics: { incrementalConversions: 5, incrementalConversionsP90LowerBound: -3, incrementalConversionsP90UpperBound: 12, incrementalConversionsPValue: 0.4 },
        }];
      }
      if (from === "lift_measurement_config") return [liftConfig("77")];
      return undefined;
    },
  });
  const body = jsonOf(await call(client, "get_lift_results", { breakdown: "AGE_RANGE" }));
  const row = (body.conversion_lift as Row[])[0];
  assert.equal(row.age_range, "AGE_RANGE_25_34");
  assert.match(String(row.verdict), /^inconclusivo/);
  assert.equal(row.significant_90, false);
  const results = calls.queries.find((q) => /metrics\.incremental_conversions/.test(q))!;
  assert.match(results, /segments\.age_range/);
  assert.doesNotMatch(results, /winner_score/);
});

test("get_lift_results: Brand Lift por campanha lê lift_measurement_campaign filtrado pelo estudo", async () => {
  const { client, calls } = fakeClient({
    respond: (from) => {
      if (from === "lift_measurement_flight") return [flight("88", "SURVEY")];
      if (from === "lift_measurement_config") return [liftConfig("88", { singleMeasurementQuestionSet: { questionMeasurements: ["RECALL"] } })];
      if (from === "lift_measurement_campaign") {
        return [{
          liftMeasurementCampaign: { liftMeasurementConfigId: "88", campaign: `customers/${CID}/campaigns/11` },
          segments: { brandLiftMeasurementType: "RECALL" },
          metrics: { absoluteBrandLift: 0.05, absoluteBrandLiftP90LowerBound: 0.02, absoluteBrandLiftP90UpperBound: 0.08, absoluteBrandLiftPValue: 0.01, brandLiftTotalResponses: 1500 },
        }];
      }
      return undefined;
    },
  });
  const body = jsonOf(await call(client, "get_lift_results", { liftMeasurementConfigId: "88", breakdown: "CAMPAIGN" }));
  const row = (body.brand_lift as Row[])[0];
  assert.equal(row.campaign, `customers/${CID}/campaigns/11`);
  assert.equal(row.question_type, "RECALL");
  assert.match(String(row.verdict), /^positivo/);
  assert.equal(row.brand_lift_total_responses, 1500);
  const query = calls.queries.find((q) => /FROM lift_measurement_campaign/.test(q))!;
  assert.match(query, /lift_measurement_campaign\.lift_measurement_config_id = 88/);
  assert.ok(!calls.queries.some((q) => /incremental_conversions/.test(q)), "breakdown CAMPAIGN não existe para Conversion Lift");
});

test("get_lift_results: breakdown incompatível com o tipo e ID inválido são recusados sem consulta", async () => {
  const { client, calls } = fakeClient();
  assert.match(textOf(await call(client, "get_lift_results", { liftType: "CONVERSION", breakdown: "VIDEO" })), /não existe para Conversion Lift/);
  assert.match(textOf(await call(client, "get_lift_results", { liftType: "BRAND", breakdown: "COUNTRY" })), /não existe para Brand Lift/);
  assert.equal((await call(client, "get_lift_results", { liftMeasurementConfigId: "7 OR 1=1" })).isError, true);
  assert.equal(calls.queries.length, 0);
});

test("get_lift_results: todas as quebras montam GAQL válido e compatível", async () => {
  const valid: Record<string, string[]> = {
    CONVERSION: ["NONE", "CONVERSION_ACTION", "AGE_RANGE", "GENDER", "DEVICE", "COUNTRY", "EXPERIMENT_ARM"],
    BRAND: ["NONE", "CAMPAIGN", "AGE_RANGE", "GENDER", "DEVICE", "VIDEO"],
  };
  for (const [liftType, breakdowns] of Object.entries(valid)) {
    for (const breakdown of breakdowns) {
      const { client, calls } = fakeClient({ respond: (from) => (from === "lift_measurement_config" ? [liftConfig("77")] : undefined) });
      await call(client, "get_lift_results", { liftType, breakdown, liftMeasurementConfigId: "77" });
      // estudos + voos + resultados (a quebra) — cada query já passou pela tabela de compatibilidade
      const results = calls.queries.filter((q) => /metrics\./.test(q));
      assert.equal(results.length, 1, `${liftType}/${breakdown}`);
    }
  }
});

// ── Formulários de lead ──────────────────────────────────────────────

interface LeadWorld {
  accepted?: boolean;
  campaigns?: Row[];
  sameName?: boolean;
  image?: Row | null;
  asset?: Row | null;
  links?: Row[];
}

function leadWorld(world: LeadWorld) {
  return (from: string, query: string): Row[] | undefined => {
    if (from === "customer") return [{ customer: { id: CID, customerAgreementSetting: { acceptedLeadFormTerms: world.accepted ?? true } } }];
    if (from === "campaign") {
      const all = world.campaigns ?? [{ id: "11", name: "Pesquisa Leads", status: "ENABLED", advertisingChannelType: "SEARCH" }];
      const asked = idsIn(query, "campaign.id");
      return all.filter((c) => !asked.length || asked.includes(String(c.id))).map((campaign) => ({ campaign }));
    }
    if (from === "asset" && /asset\.name = /.test(query)) return world.sameName ? [{ asset: { id: "650", name: "x" } }] : [];
    if (from === "asset" && /image_asset/.test(query)) return world.image === null ? [] : [{ asset: world.image ?? { id: "660", type: "IMAGE", imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 628 } } } }];
    if (from === "asset" && /asset\.id = /.test(query)) return world.asset === null ? [] : [{ asset: world.asset ?? { id: "700", name: "Form", type: "LEAD_FORM" } }];
    if (from === "campaign_asset") return world.links ?? [];
    return undefined;
  };
}

const leadForm = (over: Row = {}): Row => ({
  campaignIds: ["11"],
  businessName: "Escola Exemplo",
  headline: "Matrículas abertas",
  description: "Receba a grade e os valores do curso.",
  callToActionType: "GET_QUOTE",
  callToActionDescription: "Receba os valores",
  privacyPolicyUrl: "https://exemplo.com.br/privacidade",
  finalUrl: "https://exemplo.com.br",
  fields: [{ inputType: "FULL_NAME" }, { inputType: "EMAIL" }, { inputType: "PHONE_NUMBER" }],
  ...over,
});

test("list_lead_forms: termos, formulários, campanhas vinculadas — sem expor o segredo do webhook", async () => {
  const { client, calls } = fakeClient({
    respond: (from) => {
      if (from === "customer") return [{ customer: { id: CID, customerAgreementSetting: { acceptedLeadFormTerms: true } } }];
      if (from === "asset") {
        return [{
          asset: {
            id: "700", name: "Form Matrícula", finalUrls: ["https://exemplo.com.br"],
            leadFormAsset: {
              businessName: "Escola", headline: "Matrículas", callToActionType: "GET_QUOTE", callToActionDescription: "Valores",
              fields: [{ inputType: "FULL_NAME" }, { inputType: "PREFERRED_CONTACT_TIME", singleChoiceAnswers: { answers: ["Manhã", "Tarde"] } }],
              deliveryMethods: [{ webhook: { advertiserWebhookUrl: "https://crm.exemplo.com/hook", googleSecret: "segredo-super", payloadSchemaVersion: "3" } }],
            },
          },
        }];
      }
      if (from === "campaign_asset") {
        return [{ campaign: { id: "11", name: "Pesquisa Leads", status: "ENABLED" }, campaignAsset: { asset: `customers/${CID}/assets/700`, status: "ENABLED", primaryStatus: "ELIGIBLE" } }];
      }
      return undefined;
    },
  });
  const result = await call(client, "list_lead_forms", {});
  assert.doesNotMatch(textOf(result), /segredo-super/);
  const body = jsonOf(result);
  assert.equal(body.accepted_lead_form_terms, true);
  const form = (body.lead_forms as Row[])[0];
  assert.deepEqual(form.fields, ["FULL_NAME", "PREFERRED_CONTACT_TIME (Manhã / Tarde)"]);
  assert.equal((form.webhook as Row).google_secret, "*** (oculto)");
  assert.equal((form.campaigns as Row[])[0].campaign_id, "11");
  assert.match(calls.queries[1], /WHERE asset\.type = 'LEAD_FORM'/);
  assert.match(calls.queries[2], /campaign_asset\.field_type = 'LEAD_FORM'/);
});

test("create_lead_form: formulário e vínculo numa operação atômica, webhook no formato do exemplo oficial", async () => {
  const { client, calls } = fakeClient({ respond: leadWorld({}) });
  const result = await call(client, "create_lead_form", leadForm({
    fields: [{ inputType: "full_name" }, { inputType: "EMAIL" }, { inputType: "PREFERRED_CONTACT_TIME", answers: ["Manhã", "Tarde", "Noite"] }],
    webhook: { url: "https://crm.exemplo.com/hook", googleSecret: "segredo-super" },
    postSubmitCallToActionType: "VISIT_SITE",
    desiredIntent: "HIGH_INTENT",
  }));
  assert.equal(result.isError, undefined, textOf(result));
  const write = onlyWrite(calls);
  assert.equal(write.method, "batchMutate");
  const [assetOp, linkOp] = write.operations as Row[];
  const asset = (assetOp.assetOperation as Row).create as Row;
  assert.equal(asset.resourceName, `customers/${CID}/assets/-1`);
  assert.deepEqual(asset.finalUrls, ["https://exemplo.com.br"]);
  const form = asset.leadFormAsset as Row;
  assert.deepEqual(form.fields, [
    { inputType: "FULL_NAME" }, { inputType: "EMAIL" },
    { inputType: "PREFERRED_CONTACT_TIME", singleChoiceAnswers: { answers: ["Manhã", "Tarde", "Noite"] } },
  ]);
  assert.deepEqual(form.deliveryMethods, [{ webhook: { advertiserWebhookUrl: "https://crm.exemplo.com/hook", googleSecret: "segredo-super", payloadSchemaVersion: "3" } }]);
  assert.equal(form.desiredIntent, "HIGH_INTENT");
  assert.deepEqual((linkOp.campaignAssetOperation as Row).create, { asset: asset.resourceName, campaign: `customers/${CID}/campaigns/11`, fieldType: "LEAD_FORM" });
  assert.match(textOf(result), /Formulário de lead criado: customers\/1234567890\/assets\/700/);
  assert.doesNotMatch(textOf(result), /segredo-super/);
});

test("create_lead_form: sem termos aceitos nada é enviado", async () => {
  const { client, calls } = fakeClient({ respond: leadWorld({ accepted: false }) });
  const result = await call(client, "create_lead_form", leadForm());
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não aceitou os termos/);
  assert.equal(calls.writes.length, 0);
});

test("create_lead_form: regras de campos e perguntas recusadas antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient({ respond: leadWorld({}) });
  const cases: Array<[Row, RegExp]> = [
    [{ fields: [{ inputType: "FULL_NAME" }, { inputType: "FIRST_NAME" }] }, /FULL_NAME não pode ficar junto/],
    [{ fields: [{ inputType: "EMAIL" }, { inputType: "EMAIL" }] }, /Campo repetido/],
    [{ fields: [{ inputType: "TELEFONE" }] }, /inputType desconhecido/],
    [{ fields: [] }, /ao menos um campo/],
    [{ fields: [{ inputType: "EMAIL", answers: ["a", "b"] }] }, /só vale para perguntas pré-aprovadas/],
    [{ fields: [{ inputType: "EMAIL" }, { inputType: "PREFERRED_CONTACT_TIME", answers: ["só uma"] }] }, /2 a 12 opções/],
    [{ fields: [{ inputType: "EMAIL" }, { inputType: "VEHICLE_MODEL" }], customQuestions: [{ question: "Qual curso?" }] }, /LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED/],
    [{ customQuestions: Array.from({ length: 6 }, (_, i) => ({ question: `P${i}` })) }, /No máximo 5 perguntas personalizadas/],
    [{ customQuestions: [{ question: "x".repeat(301) }] }, /mais de 300 caracteres/],
    [{ fields: [{ inputType: "EMAIL" }, ...["VEHICLE_MODEL", "VEHICLE_TYPE", "COMPANY_SIZE", "JOB_ROLE", "PRODUCT", "SERVICE"].map((inputType) => ({ inputType }))] }, /No máximo 5 perguntas pré-aprovadas/],
    [{ privacyPolicyUrl: "exemplo.com.br/privacidade" }, /URL http\(s\) completa/],
    [{ headline: "  " }, /obrigatório\(s\) vazio\(s\): headline/],
    [{ campaignIds: ["11 OR 1=1"] }, /IDs numéricos/],
    [{ campaignIds: [] }, /ao menos uma campanha/],
    [{ webhook: { url: "https://crm.exemplo.com/hook", googleSecret: " " } }, /googleSecret vazio/],
    [{ backgroundImageAssetId: "abc" }, /numérico/],
  ];
  for (const [over, message] of cases) {
    const result = await call(client, "create_lead_form", leadForm(over));
    assert.equal(result.isError, true, JSON.stringify(over));
    assert.match(textOf(result), message, JSON.stringify(over));
  }
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.writes.length, 0);
});

test("create_lead_form: nome repetido, campanha inexistente e imagem fora de 1200x628 não gravam", async () => {
  const dup = fakeClient({ respond: leadWorld({ sameName: true }) });
  assert.match(textOf(await call(dup.client, "create_lead_form", leadForm({ name: "Form Matrícula" }))), /Já existe o formulário "Form Matrícula"/);
  assert.ok(dup.calls.queries.some((q) => /asset\.name = 'Form Matrícula'/.test(q)));

  const gone = fakeClient({ respond: leadWorld({ campaigns: [] }) });
  assert.match(textOf(await call(gone.client, "create_lead_form", leadForm())), /não encontrada/);

  const image = fakeClient({ respond: leadWorld({ image: { id: "660", type: "IMAGE", imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 1200 } } } }) });
  assert.match(textOf(await call(image.client, "create_lead_form", leadForm({ backgroundImageAssetId: "660" }))), /exatamente 1200x628/);

  for (const { calls } of [dup, gone, image]) assert.equal(calls.writes.length, 0);
});

test("create_lead_form: erro da API é explicado; validateOnly não diz que criou", async () => {
  const refused = fakeClient({
    respond: leadWorld({}),
    batchMutate: () => { throw new Error(`Google Ads API: Request contains an invalid argument. — ${API_MESSAGES.LEAD_FORM_MISSING_AGREEMENT}`); },
  });
  const result = await call(refused.client, "create_lead_form", leadForm());
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi gravado \(operação atômica\)/);
  assert.match(textOf(result), /não aceitou os termos/);

  const dry = fakeClient({ respond: leadWorld({}) });
  const validated = await call(dry.client, "create_lead_form", leadForm({ validateOnly: true }));
  assert.equal(onlyWrite(dry.calls).dryRun, true);
  assert.match(textOf(validated), /VALIDATE-ONLY/);
  assert.doesNotMatch(textOf(validated), /Formulário de lead criado/);
});

test("link_lead_form_to_campaigns: pula vínculo ativo, não reativa pausado e vincula o resto com partialFailure", async () => {
  const { client, calls } = fakeClient({
    respond: leadWorld({
      campaigns: [
        { id: "11", name: "A", status: "ENABLED" }, { id: "12", name: "B", status: "ENABLED" }, { id: "13", name: "C", status: "ENABLED" },
      ],
      links: [
        { campaign: { id: "11" }, campaignAsset: { resourceName: `customers/${CID}/campaignAssets/11~700~LEAD_FORM`, status: "ENABLED" } },
        { campaign: { id: "12" }, campaignAsset: { resourceName: `customers/${CID}/campaignAssets/12~700~LEAD_FORM`, status: "PAUSED" } },
      ],
    }),
  });
  const result = await call(client, "link_lead_form_to_campaigns", { assetId: "700", campaignIds: ["11", "12", "13"] });
  const write = onlyWrite(calls);
  assert.equal(write.method, "mutate:campaignAssets");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [{ create: { asset: `customers/${CID}/assets/700`, campaign: `customers/${CID}/campaigns/13`, fieldType: "LEAD_FORM" } }]);
  const report = jsonOf(result) as unknown as Row[];
  assert.equal(report.find((r) => r.campaign_id === "11")!.result, "sem mudança");
  assert.match(String(report.find((r) => r.campaign_id === "12")!.reason), /nada foi reativado/);
  assert.equal(report.find((r) => r.campaign_id === "13")!.result, "vinculado");
});

test("link_lead_form_to_campaigns: UNLINK exige confirm; asset que não é LEAD_FORM é recusado; falha por item", async () => {
  const { client, calls } = fakeClient({ respond: leadWorld({}) });
  assert.match(textOf(await call(client, "link_lead_form_to_campaigns", { assetId: "700", campaignIds: ["11"], action: "UNLINK" })), /confirm: true/);
  assert.equal(calls.queries.length, 0);

  const unlink = fakeClient({
    respond: leadWorld({ links: [{ campaign: { id: "11" }, campaignAsset: { resourceName: `customers/${CID}/campaignAssets/11~700~LEAD_FORM`, status: "ENABLED" } }] }),
  });
  await call(unlink.client, "link_lead_form_to_campaigns", { assetId: "700", campaignIds: ["11"], action: "UNLINK", confirm: true });
  assert.deepEqual(onlyWrite(unlink.calls).operations, [{ remove: `customers/${CID}/campaignAssets/11~700~LEAD_FORM` }]);

  const image = fakeClient({ respond: leadWorld({ asset: { id: "700", name: "Banner", type: "IMAGE" } }) });
  assert.match(textOf(await call(image.client, "link_lead_form_to_campaigns", { assetId: "700", campaignIds: ["11"] })), /não LEAD_FORM/);
  assert.equal(image.calls.writes.length, 0);

  const partial = fakeClient({
    respond: leadWorld({}),
    mutate: () => ({
      results: [{}],
      partialFailureError: { details: [{ errors: [{ message: "Campaign type not eligible", location: { fieldPathElements: [{ fieldName: "operations", index: 0 }] } }] }] },
    }),
  });
  const failed = await call(partial.client, "link_lead_form_to_campaigns", { assetId: "700", campaignIds: ["11"] });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Campaign type not eligible/);
});

test("get_lead_form_submissions: respostas por campo, filtros, ordem e limite", async () => {
  const { client, calls } = fakeClient({
    respond: () => [{
      leadFormSubmissionData: {
        id: "lead-1", submissionDateTime: "2026-09-20 10:15:00-03:00", gclid: "Cj0KCQ",
        campaign: `customers/${CID}/campaigns/11`, asset: `customers/${CID}/assets/700`,
        leadFormSubmissionFields: [{ fieldType: "FULL_NAME", fieldValue: "Maria Silva" }, { fieldType: "EMAIL", fieldValue: "maria@exemplo.com" }, { fieldType: "PHONE_NUMBER", fieldValue: "+55 11 91234-5678" }],
        customLeadFormSubmissionFields: [{ questionText: "Qual curso?", fieldValue: "Inglês" }],
      },
      campaign: { id: "11", name: "Pesquisa Leads" }, adGroup: { name: "Grupo 1" }, asset: { name: "Form Matrícula" },
    }],
  });
  const result = await call(client, "get_lead_form_submissions", { days: 7, campaignId: "11", assetId: "700", limit: 50 });
  const leads = jsonOf(result) as unknown as Row[];
  assert.deepEqual(leads[0].fields, { FULL_NAME: "Maria Silva", EMAIL: "maria@exemplo.com", PHONE_NUMBER: "+55 11 91234-5678" });
  assert.deepEqual(leads[0].custom_answers, { "Qual curso?": "Inglês" });
  assert.equal(leads[0].form, "Form Matrícula");
  const query = calls.queries[0];
  assert.match(query, /lead_form_submission_data\.submission_date_time >= '\d{4}-\d{2}-\d{2} 00:00:00'/);
  assert.match(query, /campaign\.id = 11/);
  assert.match(query, /asset\.id = 700/);
  assert.match(query, /ORDER BY lead_form_submission_data\.submission_date_time DESC/);
  assert.match(query, /LIMIT 50/);
  assert.match(textOf(result), /guarda os leads por 60 dias/);

  const redacted = textOf(await call(client, "get_lead_form_submissions", { redact: true }));
  assert.doesNotMatch(redacted, /maria@exemplo\.com|Maria Silva|91234|Cj0KCQ/);
  assert.match(redacted, /m\*\*\*@exemplo\.com/);
  assert.match(redacted, /\*\*\*78/);
});

test("get_lead_form_submissions: janela acima de 60 dias, datas e limite inválidos não consultam", async () => {
  const { client, calls } = fakeClient();
  for (const args of [
    { days: 61 }, { days: 0 }, { dateRange: { since: "2026-09-10", until: "2026-09-01" } },
    { dateRange: { since: "2026-09-01' OR '1'='1", until: "2026-09-10" } }, { limit: 0 }, { limit: 20_000 }, { campaignId: "x" },
  ]) {
    assert.equal((await call(client, "get_lead_form_submissions", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
  await call(client, "get_lead_form_submissions", { dateRange: { since: "2026-09-01", until: "2026-09-10" } });
  assert.match(calls.queries[0], /submission_date_time >= '2026-09-01 00:00:00' AND lead_form_submission_data\.submission_date_time <= '2026-09-10 23:59:59'/);
});

// ── Dicas de erro: casam com o texto que a API devolve (não com o nome do enum) ──

const VALUE_RULE_HINT_CASES: Array<[keyof typeof API_MESSAGES, RegExp]> = [
  ["CONFLICTING_CONDITIONS", /condição conflitante/],
  ["CONFLICTING_VALUE_RULE_CONDITIONS", /condição conflitante/],
  ["CONDITION_NOT_ALLOWED", /não está nas dimensões do conjunto/],
  ["CONDITION_TYPE_NOT_ALLOWED", /não está nas dimensões do conjunto/],
  ["VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE", /só em campanhas de Pesquisa ou Display/],
  ["CANNOT_REMOVE_IF_INCLUDED_IN_VALUE_RULE_SET", /A regra ainda está num conjunto/],
  ["CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED", /pausados juntos/],
  ["CANNOT_PAUSE_UNLESS_ALL_VALUE_RULES_ARE_PAUSED", /pausados juntos/],
  ["SHOULD_PAUSE_WHEN_ALL_VALUE_RULES_ARE_PAUSED", /pausados juntos/],
  ["DIMENSIONS_UPDATE_ONLY_ALLOW_APPEND", /só podem ser acrescentadas/],
  ["INVALID_GEO_TARGET_CONSTANT", /Confira os locais/],
  ["CONFLICTING_INCLUDED_AND_EXCLUDED_GEO_TARGET", /Confira os locais/],
  ["UNTARGETABLE_GEO_TARGET", /Confira os locais/],
  ["INVALID_AUDIENCE_USER_LIST", /Lista de público ou interesse/],
  ["INACCESSIBLE_USER_LIST", /Lista de público ou interesse/],
  ["INVALID_AUDIENCE_USER_INTEREST", /Lista de público ou interesse/],
  ["DATA_CONSTRAINT_VIOLATION", /outro conjunto ENABLED\/PAUSED/],
];
const LEAD_FORM_HINT_CASES: Array<[keyof typeof API_MESSAGES, RegExp]> = [
  ["LEAD_FORM_MISSING_AGREEMENT", /não aceitou os termos/],
  ["LEAD_FORM_INVALID_FIELDS_COMBINATION", /Combinação de campos recusada/],
  ["LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED", /Perguntas pré-aprovadas/],
  ["LEAD_FORM_LOCATION_ANSWER_TYPE_DISALLOWED", /Resposta do tipo local/],
  ["DUPLICATE_ASSET_NAME", /Já existe um asset com esse nome/],
  ["NAME_CONFLICT_FOR_ASSET_TYPE", /Já existe um asset com esse nome/],
  ["POLICY_FINDING", /Recusado por política/],
  ["POLICY_ERROR", /Recusado por política/],
];
const apiError = (message: string) => new Error(`Google Ads API: Request contains an invalid argument. — ${message}`);
const hintOf = (result: Result) => /\n→ (.*)$/m.exec(textOf(result))?.[1] ?? "";

test("dicas de erro das regras de valor: cada uma casa com o texto real da API (sem nome de enum)", async () => {
  for (const [code, expected] of VALUE_RULE_HINT_CASES) {
    const message = API_MESSAGES[code];
    assert.ok(!message.includes(code), `${code}: a mensagem de teste não pode trazer o nome do enum`);
    const { client } = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }), mutate: () => { throw apiError(message); } });
    const result = await call(client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 2 });
    assert.equal(result.isError, true, code);
    assert.match(hintOf(result), expected, `${code}: dica ausente ou errada em "${textOf(result)}"`);
  }
  // Erro desconhecido: sem dica inventada.
  const { client } = fakeClient({ respond: ruleWorld({ rules: [rule("1")], sets: [ruleSet("50", ["1"])] }), mutate: () => { throw apiError("Internal error encountered."); } });
  const unknown = await call(client, "update_conversion_value_rule", { conversionValueRuleId: "1", value: 2 });
  assert.equal(hintOf(unknown), "");
  assert.match(textOf(unknown), /Internal error encountered/);
});

test("dicas de erro dos formulários de lead: cada uma casa com o texto real da API (sem nome de enum)", async () => {
  for (const [code, expected] of LEAD_FORM_HINT_CASES) {
    const message = API_MESSAGES[code];
    assert.ok(!message.includes(code), `${code}: a mensagem de teste não pode trazer o nome do enum`);
    const { client } = fakeClient({ respond: leadWorld({}), batchMutate: () => { throw apiError(message); } });
    const result = await call(client, "create_lead_form", leadForm());
    assert.equal(result.isError, true, code);
    assert.match(hintOf(result), expected, `${code}: dica ausente ou errada em "${textOf(result)}"`);
  }
});

// ── get_purchase_conversions (tool existente, revista) ───────────────

test("get_purchase_conversions: agrupa por campaign.id, mostra compras secundárias e aceita filtro/formatos", async () => {
  const { client, calls } = fakeClient({
    respond: () => [
      { campaign: { id: "11", name: "Shopping" }, metrics: { conversions: 3.3333, conversionsValue: 300.555, allConversions: 5, allConversionsValue: 450 } },
      { campaign: { id: "12", name: "Shopping" }, metrics: { conversions: 1, conversionsValue: 100, allConversions: 1, allConversionsValue: 100 } },
    ],
  });
  const result = await call(client, "get_purchase_conversions", { days: 30 });
  const rows = jsonOf(result) as unknown as Row[];
  assert.equal(rows.length, 2, "campanhas com o mesmo nome não se misturam");
  assert.equal(rows[0].campaign_id, "11");
  assert.equal(rows[0].purchase_conversions, 3.33);
  assert.equal(rows[0].all_purchase_conversions, 5);
  assert.match(textOf(result), /Total: 4\.33 compras/);
  assert.match(textOf(result), /Todas as conversões de compra: 6/);
  assert.match(calls.queries[0], /metrics\.all_conversions_value/);

  await call(client, "get_purchase_conversions", { campaignId: "11", format: "csv" });
  assert.match(calls.queries[1], /campaign\.id = 11/);
  const invalid = fakeClient();
  assert.equal((await call(invalid.client, "get_purchase_conversions", { campaignId: "11 OR 1=1" })).isError, true);
  assert.equal(invalid.calls.queries.length, 0);
});

// ── GoogleAdsClient real, fetch interceptado ─────────────────────────

const CREDENTIALS = {
  token: "test-token",
  refresh_token: "test-refresh",
  token_uri: "https://oauth2.googleapis.com/token",
  client_id: "test-client",
  client_secret: "test-secret",
  expiry: "2999-01-01T00:00:00.000Z",
};

test("dry-run de ponta a ponta: create_conversion_value_rule manda um googleAds:mutate com validateOnly", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    sent.push({ url, body });
    let payload: unknown = {};
    if (url.endsWith(":searchStream")) {
      const query = String(body.query);
      assertGaqlRules(query);
      payload = /FROM geo_target_constant/.test(query)
        ? [{ results: [{ geoTargetConstant: { id: GEO_SP, canonicalName: "Sao Paulo,Brazil" } }] }]
        : [{ results: [] }];
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({ credentials: CREDENTIALS, developerToken: "dev", loginCustomerId: CID, dryRun: true });
    const result = await call(client, "create_conversion_value_rule", { operation: "MULTIPLY", value: 1.2, geoTargetConstantIds: [GEO_SP] });
    const writes = sent.filter((s) => !s.url.endsWith(":searchStream"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    const ops = writes[0].body.mutateOperations as Row[];
    assert.deepEqual(Object.keys(ops[0]), ["conversionValueRuleOperation"]);
    assert.deepEqual(Object.keys(ops[1]), ["conversionValueRuleSetOperation"]);
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    globalThis.fetch = original;
  }
});

test("GoogleAdsClient real: HTTP 400 com errorCode + message ganha a dica pelo texto (o client descarta o errorCode)", async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    sent.push(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith(":searchStream")) {
      const query = String(body.query);
      assertGaqlRules(query);
      if (/FROM conversion_value_rule_set/.test(query)) return json([{ results: [ruleSet("50", ["1", "2"])] }]);
      if (/FROM conversion_value_rule\b/.test(query)) return json([{ results: [rule("1")] }]);
      return json([{ results: [] }]);
    }
    // Formato do erro REST do Google Ads: details[].errors[] com errorCode e message.
    return json({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
        details: [{
          "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
          errors: [{
            errorCode: { conversionValueRuleError: "CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED" },
            message: API_MESSAGES.CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED,
          }],
        }],
      },
    }, 400);
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({ credentials: CREDENTIALS, developerToken: "dev", loginCustomerId: CID });
    const result = await call(client, "update_conversion_value_rule", { conversionValueRuleId: "1", status: "PAUSED" });
    assert.ok(sent.some((url) => url.endsWith(`/customers/${CID}/conversionValueRules:mutate`)));
    assert.equal(result.isError, true);
    const message = textOf(result);
    assert.doesNotMatch(message, /CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED/, "o client real não repassa o errorCode");
    assert.match(message, /Nada foi gravado/);
    assert.match(message, /Pausing the value rule requires pausing the value rule set/);
    assert.match(message, /\n→ A API exige que regra e conjunto sejam pausados juntos/);
  } finally {
    globalThis.fetch = original;
  }
});
