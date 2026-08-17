import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertHostedReadOnlySecurity,
  parseAllowedCustomerIds,
} from "../src/hosted-config.js";
import { GOOGLE_ADS_READ_TOOL_NAMES } from "../src/read-only.js";

/**
 * An empty customer allowlist used to mean "do not filter", on a server whose
 * OAuth credential can reach every customer under the MCC. One client's service
 * misconfigured that way would answer for another client's accounts, so the
 * empty case now stops the service instead of widening it.
 *
 * These tests pin the four states that matter: a good allowlist works, and
 * absent, empty and malformed each refuse.
 */

test("a well-formed allowlist parses and normalises", () => {
  assert.deepEqual(parseAllowedCustomerIds("1234567890"), ["1234567890"]);
  /* Google writes customer ids both ways; storing one form and comparing the
     other would deny silently. */
  assert.deepEqual(parseAllowedCustomerIds("123-456-7890"), ["1234567890"]);
  assert.deepEqual(parseAllowedCustomerIds(" 1234567890 , 9876543210 "), [
    "1234567890",
    "9876543210",
  ]);
  assert.deepEqual(parseAllowedCustomerIds("1234567890,1234567890"), [
    "1234567890",
  ]);
});

test("an absent allowlist is refused, not treated as a wildcard", () => {
  assert.throws(() => parseAllowedCustomerIds(undefined), /not a wildcard/);
});

test("an empty or whitespace allowlist is refused", () => {
  assert.throws(() => parseAllowedCustomerIds(""), /not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds("   "), /not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds(",,"), /not a wildcard/);
});

test("a malformed allowlist is refused rather than partially honoured", () => {
  /* Half an allowlist is worse than none: it looks configured. */
  assert.throws(() => parseAllowedCustomerIds("not-a-customer"), /10-digit/);
  assert.throws(() => parseAllowedCustomerIds("12345"), /10-digit/);
  assert.throws(() => parseAllowedCustomerIds("1234567890,oops"), /10-digit/);
});

test("hosted read-only mode will not start without an allowlist", () => {
  const base = {
    port: 3333,
    readOnly: true,
    apiKey: "k".repeat(32),
    allowedHosts: ["ads.internal"],
  };

  assert.throws(
    () => assertHostedReadOnlySecurity({ ...base, allowedCustomerIds: [] }),
    /ALLOWED_CUSTOMER_IDS is required/,
  );
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({ ...base, allowedCustomerIds: ["1234567890"] }),
  );
});

test("stdio mode is left alone, so local use is unchanged", () => {
  /* port 0 means stdio; the hosted gate does not apply there. */
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({
      port: 0,
      readOnly: true,
      apiKey: "",
      allowedHosts: [],
      allowedCustomerIds: [],
    }),
  );
});

test("the pilot's shape still passes", () => {
  /* The pilot runs hosted read-only with a populated allowlist. This change
     must not disturb it, which is the whole reason the gate keys on emptiness
     rather than on anything about the values. */
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({
      port: 3333,
      readOnly: true,
      apiKey: "k".repeat(32),
      allowedHosts: ["google-ads-mcp.railway.internal"],
      allowedCustomerIds: parseAllowedCustomerIds("123-456-7890"),
    }),
  );
});

test("every exposed read tool is account-scoped and discovery is filtered", () => {
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
  const starts = [...source.matchAll(/mcp\.registerTool\(\s*\n?\s*"([^"]+)"/g)];
  const slices = new Map<string, string>();
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    slices.set(current[1], source.slice(current.index, starts[index + 1]?.index ?? source.length));
  }
  for (const name of GOOGLE_ADS_READ_TOOL_NAMES) {
    const implementation = slices.get(name);
    assert.ok(implementation, `missing implementation for ${name}`);
    if (name === "list_accounts") {
      assert.match(implementation, /allowedCustomerIdSet\.has/);
    } else {
      assert.match(implementation, /checkCustomerAccess\(/, `${name} lacks account guard`);
    }
  }
});
