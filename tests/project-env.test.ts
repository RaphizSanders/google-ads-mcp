/**
 * .env do projeto (ao lado de dist/): completa o ambiente sem sobrescrever e sem
 * misturar credenciais. Regressão: o fallback dependia de GOOGLE_ADS_LOGIN_CUSTOMER_ID,
 * que o bloco env do cliente MCP sempre define — READ_ONLY do .env sumia em silêncio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillFromProjectEnv } from "../src/project-env.ts";

const PROJECT_ENV = [
  "GOOGLE_ADS_CREDENTIALS_PATH=/srv/creds.json",
  "GOOGLE_ADS_READ_ONLY=true",
  "GOOGLE_ADS_DRY_RUN=true",
  "ALLOWED_CUSTOMER_IDS=5820067509",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID=1111111111",
].join("\n");

test("cliente define só o MCC: as travas do .env do projeto continuam valendo", () => {
  const env: NodeJS.ProcessEnv = { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2222222222" };
  fillFromProjectEnv(PROJECT_ENV, env);
  assert.equal(env.GOOGLE_ADS_READ_ONLY, "true");
  assert.equal(env.GOOGLE_ADS_DRY_RUN, "true");
  assert.equal(env.ALLOWED_CUSTOMER_IDS, "5820067509");
  assert.equal(env.GOOGLE_ADS_CREDENTIALS_PATH, "/srv/creds.json");
  assert.equal(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, "2222222222", "o bloco env do cliente vence");
});

test("valor já definido (mesmo vazio ou false) nunca é sobrescrito", () => {
  const env: NodeJS.ProcessEnv = { GOOGLE_ADS_READ_ONLY: "false", ALLOWED_CUSTOMER_IDS: "" };
  fillFromProjectEnv(PROJECT_ENV, env);
  assert.equal(env.GOOGLE_ADS_READ_ONLY, "false");
  assert.equal(env.ALLOWED_CUSTOMER_IDS, "");
});

test("credencial do .env do projeto não se soma a outra já definida", () => {
  const env: NodeJS.ProcessEnv = { GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH: "/srv/sa.json" };
  const applied = fillFromProjectEnv(PROJECT_ENV, env);
  assert.equal(env.GOOGLE_ADS_CREDENTIALS_PATH, undefined);
  assert.ok(!applied.includes("GOOGLE_ADS_CREDENTIALS_PATH"));
  assert.equal(env.GOOGLE_ADS_READ_ONLY, "true", "o resto do arquivo ainda completa o ambiente");
});
