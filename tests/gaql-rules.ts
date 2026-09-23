/**
 * Regras de GAQL que a API aplica e que um client falso esconderia.
 *
 * Um fake que aceita qualquer query deixou passar um bug real (campaign.id no
 * WHERE de FROM campaign_asset sem estar no SELECT — a API recusa). Todo client
 * falso dos testes passa as queries por aqui.
 */

import assert from "node:assert/strict";

/**
 * Recursos de SEGMENTAÇÃO por recurso do FROM (field reference v25). Campo de
 * recurso de segmentação usado no WHERE precisa estar no SELECT. Recursos
 * *atribuídos* (ex.: campaign em search_term_view) não têm essa exigência.
 */
const SEGMENTING_RESOURCES: Record<string, string[]> = {
  campaign_asset: ["campaign", "ad_group"],
  expanded_landing_page_view: ["campaign", "ad_group", "landing_page_view"],
};

/** Segmentos de data que podem ir no WHERE sem estar no SELECT. */
const CORE_DATE_SEGMENTS = new Set(["date", "week", "month", "quarter", "year"]);

/**
 * Mensagens com subcampos que um updateMask não pode nomear inteiras: a API recusa com
 * FieldMaskError.FIELD_HAS_SUBFIELDS ("fields with subfields may be cleared, but not
 * updated"). O caminho certo é uma folha (ex.: maximize_conversions.target_cpa_micros).
 * Campos repetidos (asset_automation_settings, final_urls) podem ir inteiros.
 */
const MESSAGE_FIELDS_WITH_SUBFIELDS = new Set([
  "maximize_conversions",
  "maximize_conversion_value",
  "target_spend",
  "manual_cpc",
  "target_impression_share",
  "target_cpa",
  "target_roas",
  "network_settings",
  "ai_max_setting",
  "text_guidelines",
  "ai_max_ad_group_setting",
]);

export function assertUpdateMaskLeaves(updateMask: string): void {
  for (const path of updateMask.split(",")) {
    assert.ok(!MESSAGE_FIELDS_WITH_SUBFIELDS.has(path), `updateMask nomeia a mensagem "${path}" — a API recusa (FIELD_HAS_SUBFIELDS)`);
  }
}

export function assertGaqlRules(query: string): void {
  const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1];
  if (!from) return;
  const select = query.slice(0, query.search(/\bFROM\b/));
  const where = (query.split(/\bWHERE\b/)[1] ?? "").split(/\b(ORDER BY|LIMIT)\b/)[0];

  for (const resource of SEGMENTING_RESOURCES[from] ?? []) {
    for (const [field] of where.matchAll(new RegExp(`\\b${resource}\\.[a-z_.]+`, "g"))) {
      assert.ok(select.includes(field), `${field} no WHERE sem estar no SELECT (FROM ${from}) — a API recusa: ${query}`);
    }
  }
  for (const [field, name] of where.matchAll(/\bsegments\.([a-z_]+)/g)) {
    if (CORE_DATE_SEGMENTS.has(name)) continue;
    assert.ok(select.includes(field), `${field} no WHERE sem estar no SELECT — a API recusa: ${query}`);
  }
}
