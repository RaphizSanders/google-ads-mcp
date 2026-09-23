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

export function assertGaqlRules(query: string): void {
  const errors = validateGaql(query);
  assert.deepEqual(errors, [], `GAQL inválido para a API:\n- ${errors.join("\n- ")}\n\n${query.replace(/\s+/g, " ").trim()}`);
}
