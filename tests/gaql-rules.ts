/**
 * Regras que a API aplica e que um client falso esconderia.
 *
 * Um fake que aceita qualquer query deixou passar bugs reais mais de uma vez (campo
 * inexistente, segmento incompatível com o FROM, recurso de segmentação no WHERE sem
 * estar no SELECT). Todo client falso dos testes passa as queries por aqui, e elas são
 * validadas contra os metadados reais da v25 (tests/gaql-validator.ts).
 */

import assert from "node:assert/strict";
import { validateGaql } from "./gaql-validator.js";

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

/**
 * Restrições que só aparecem em runtime: os metadados da v25 não as descrevem, o validador aceita a
 * query e a API recusa. Cada regra traz a mensagem que a API real devolveu.
 */
const RUNTIME_RULES: Record<string, (query: string) => string | null> = {
  final_url_expansion_asset_view: (query) => {
    // "FinalUrlExpansionAssetView requires advertising channel type filter along with campaign id filter."
    // Com IN: "...can only be selected when filtering by a single advertising channel type in WHERE clause."
    // DEMAND_GEN, SHOPPING, DISPLAY, VIDEO...: "Invalid advertising channel type X in filter."
    const channel = /\bcampaign\.advertising_channel_type\s*=\s*'(PERFORMANCE_MAX|SEARCH)'/.exec(query)?.[1];
    if (!/\bcampaign\.id\s*=\s*\d+/.test(query) || !channel) {
      return "final_url_expansion_asset_view exige campaign.id = N junto de campaign.advertising_channel_type = 'PERFORMANCE_MAX' | 'SEARCH'";
    }
    // PMax: "Cannot select ad group in the query." — Pesquisa: "Cannot select asset group in the query."
    const select = /\bSELECT\s+([\s\S]*?)\s+FROM\s/i.exec(query)?.[1] ?? "";
    const group = channel === "PERFORMANCE_MAX" ? "ad_group" : "asset_group";
    return new RegExp(`(^|[\\s,.])${group}\\b`).test(select)
      ? `final_url_expansion_asset_view de ${channel} não aceita ${group} no SELECT`
      : null;
  },
};

export function assertGaqlRules(query: string): void {
  const from = /\bFROM\s+([a-z_]+)/i.exec(query)?.[1] ?? "";
  const runtime = RUNTIME_RULES[from]?.(query);
  const errors = [...validateGaql(query), ...(runtime ? [runtime] : [])];
  assert.deepEqual(errors, [], `GAQL inválido para a API:\n- ${errors.join("\n- ")}\n\n${query.replace(/\s+/g, " ").trim()}`);
}
