/**
 * Trava os valores que o MCP envia para a Google Ads API.
 *
 * O bug que originou estas tools foi exatamente uma lista de enum desatualizada:
 * `LEAD`, `SIGN_UP`, `UPLOAD`, `PHONE_CALL` e todos os modelos de atribuição
 * antigos eram aceitos pelo schema e recusados pela API. O teste compara o que
 * os mapas produzem com os valores reais dos protos da v25.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTRIBUTION_MODEL_ALIASES,
  CONVERSION_CATEGORIES,
  CONVERSION_CATEGORY_ALIASES,
  CONVERSION_TYPE_ALIASES,
  attributionModelSchema,
  conversionCategorySchema,
  conversionTypeSchema,
  resolveEnumAlias,
} from "../src/tools.js";

// Ground truth: google/ads/googleads/v25/enums/conversion_action_category.proto
const V25_CATEGORIES = new Set([
  "DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART", "BEGIN_CHECKOUT",
  "SUBSCRIBE_PAID", "PHONE_CALL_LEAD", "IMPORTED_LEAD", "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT",
  "REQUEST_QUOTE", "GET_DIRECTIONS", "OUTBOUND_CLICK", "CONTACT", "ENGAGEMENT", "STORE_VISIT",
  "STORE_SALE", "QUALIFIED_LEAD", "CONVERTED_LEAD", "YOUTUBE_FOLLOW_ON_VIEWS",
]);

// Ground truth: google/ads/googleads/v25/enums/conversion_action_type.proto (subset criável)
const V25_TYPES = new Set([
  "WEBPAGE", "UPLOAD_CLICKS", "UPLOAD_CALLS", "AD_CALL", "CLICK_TO_CALL", "WEBSITE_CALL",
]);

// Ground truth: google/ads/googleads/v25/enums/attribution_model.proto
const V25_ATTRIBUTION = new Set([
  "GOOGLE_ADS_LAST_CLICK",
  "GOOGLE_SEARCH_ATTRIBUTION_FIRST_CLICK",
  "GOOGLE_SEARCH_ATTRIBUTION_LINEAR",
  "GOOGLE_SEARCH_ATTRIBUTION_TIME_DECAY",
  "GOOGLE_SEARCH_ATTRIBUTION_POSITION_BASED",
  "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
]);

test("every value the category schema accepts resolves to a real v25 category", () => {
  for (const accepted of conversionCategorySchema.options) {
    const sent = resolveEnumAlias(accepted, CONVERSION_CATEGORY_ALIASES);
    assert.ok(V25_CATEGORIES.has(sent), `${accepted} -> ${sent} nao existe na v25`);
  }
  // os nomes que a API removeu continuam aceitos, mas nunca sao enviados como estao
  assert.equal(resolveEnumAlias("LEAD", CONVERSION_CATEGORY_ALIASES), "SUBMIT_LEAD_FORM");
  assert.equal(resolveEnumAlias("SIGN_UP", CONVERSION_CATEGORY_ALIASES), "SIGNUP");
  assert.ok(!CONVERSION_CATEGORIES.includes("LEAD" as never));
  assert.ok(!CONVERSION_CATEGORIES.includes("SIGN_UP" as never));
});

test("every value the type schema accepts resolves to a real v25 conversion type", () => {
  for (const accepted of conversionTypeSchema.options) {
    const sent = resolveEnumAlias(accepted, CONVERSION_TYPE_ALIASES);
    assert.ok(V25_TYPES.has(sent), `${accepted} -> ${sent} nao existe na v25`);
  }
  assert.equal(resolveEnumAlias("UPLOAD", CONVERSION_TYPE_ALIASES), "UPLOAD_CLICKS");
  assert.equal(resolveEnumAlias("PHONE_CALL", CONVERSION_TYPE_ALIASES), "WEBSITE_CALL");
});

test("attribution models: only the two the API still accepts are offered", () => {
  for (const accepted of attributionModelSchema.options) {
    const sent = resolveEnumAlias(accepted, ATTRIBUTION_MODEL_ALIASES);
    assert.ok(V25_ATTRIBUTION.has(sent), `${accepted} -> ${sent} nao existe na v25`);
    assert.ok(
      sent === "GOOGLE_ADS_LAST_CLICK" || sent === "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN",
      `${sent} foi desligado pelo Google em 2023 e nao pode ser gravado`
    );
  }
  // modelos baseados em regras nao podem voltar para o schema por engano
  for (const sunset of ["FIRST_CLICK", "LINEAR", "TIME_DECAY", "POSITION_BASED"]) {
    assert.equal(attributionModelSchema.safeParse(sunset).success, false, `${sunset} nao pode ser aceito`);
  }
});

test("a value that is already the API name passes through untouched", () => {
  assert.equal(resolveEnumAlias("PURCHASE", CONVERSION_CATEGORY_ALIASES), "PURCHASE");
  assert.equal(resolveEnumAlias("WEBPAGE", CONVERSION_TYPE_ALIASES), "WEBPAGE");
  assert.equal(resolveEnumAlias("GOOGLE_ADS_LAST_CLICK", ATTRIBUTION_MODEL_ALIASES), "GOOGLE_ADS_LAST_CLICK");
});
