/**
 * Varredura: executa TODAS as tools registradas contra um client falso que valida cada
 * query GAQL com os metadados reais da v25 (tests/gaql-validator.ts).
 *
 * Os argumentos saem do próprio schema zod de cada tool; parâmetros enum são variados um
 * de cada vez, para cobrir os ramos (view, level, tipo...). Não prova que a tool faz a
 * coisa certa — prova que nenhuma query que ela monta seria recusada pela API.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { registerGoogleAdsTools } from "../src/tools.js";
import { validateGaql } from "./gaql-validator.js";

type Row = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const CID = "1234567890";

function fakeClient(queries: string[]) {
  const ok = { results: [{ resourceName: `customers/${CID}/campaigns/111` }], mutateOperationResponses: [] };
  const client: Row = {
    isDryRun: false,
    withDryRun: () => client,
    searchStream: async (_c: string, query: string) => { queries.push(query); return []; },
    search: async (_c: string, query: string) => { queries.push(query); return []; },
    listAccessibleCustomers: async () => [CID],
    getCustomer: async () => ({ customer: { id: CID, currencyCode: "BRL", timeZone: "America/Sao_Paulo" } }),
    getAccountCurrency: async () => "BRL",
    listChildAccounts: async () => [],
  };
  return new Proxy(client, {
    get(target, property) {
      if (property in target) return target[property as string];
      // qualquer método de escrita/ação responde sucesso genérico
      return async () => ok;
    },
  });
}

/** Valor de exemplo para um tipo zod, pelo nome do parâmetro. */
function sample(name: string, type: z.ZodTypeAny): unknown {
  let t = type;
  while (t instanceof z.ZodOptional || t instanceof z.ZodDefault || t instanceof z.ZodNullable || t instanceof z.ZodEffects) {
    t = t instanceof z.ZodEffects ? t.innerType() : (t as z.ZodOptional<z.ZodTypeAny>).unwrap?.() ?? (t._def.innerType as z.ZodTypeAny);
  }
  if (t instanceof z.ZodUnion) return sample(name, t.options[0]);
  if (t instanceof z.ZodEnum) return t.options[0];
  if (t instanceof z.ZodBoolean) return false;
  if (t instanceof z.ZodNumber) return /days|limit/i.test(name) ? 30 : 1_000_000;
  if (t instanceof z.ZodArray) return [sample(name.replace(/s$/, ""), t.element)];
  if (t instanceof z.ZodObject) {
    if (/dateRange/i.test(name)) return { since: "2026-08-01", until: "2026-08-31" };
    return Object.fromEntries(Object.entries(t.shape as Record<string, z.ZodTypeAny>).map(([k, v]) => [k, sample(k, v)]));
  }
  if (/customerId/.test(name)) return CID;
  if (/Id$|Ids?$|^id$/i.test(name)) return "111";
  if (/resourceName/i.test(name)) return `customers/${CID}/assets/111`;
  if (/url/i.test(name)) return "https://exemplo.com.br";
  if (/date/i.test(name)) return "2026-08-01";
  if (/query|text|keyword/i.test(name)) return "tenis";
  return "teste";
}

function enumOptions(type: z.ZodTypeAny): string[] | undefined {
  let t = type;
  while (t instanceof z.ZodOptional || t instanceof z.ZodDefault) t = (t as z.ZodOptional<z.ZodTypeAny>).unwrap();
  return t instanceof z.ZodEnum ? (t.options as string[]) : undefined;
}

function registerAll() {
  const tools: Array<{ name: string; shape: Record<string, z.ZodTypeAny>; handler: Handler }> = [];
  const queries: string[] = [];
  const fakeMcp = {
    registerTool(name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, handler: Handler) {
      tools.push({ name, shape: config.inputSchema ?? {}, handler });
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => fakeClient(queries) as never, [], false);
  return { tools, queries };
}

/**
 * Queries inválidas que já existiam antes da varredura. Cada entrada é uma tool com bug
 * conhecido; a lista tem que ficar vazia — quem corrige a tool remove a entrada.
 */
const KNOWN_BROKEN = new Set<string>([
  "get_daily_trend", // #21 — filtro campaign.id em FROM customer
]);

/** run_gaql executa a query que o usuário escreve: não há query "da tool" para validar. */
const SKIP = new Set(["run_gaql"]);

test("varredura: nenhuma tool monta GAQL que a API recusaria", async () => {
  const { tools } = registerAll();
  assert.ok(tools.length > 0);
  const broken = new Map<string, Set<string>>();

  const withQueries = new Set<string>();
  let validated = 0;
  for (const tool of tools) {
    if (SKIP.has(tool.name)) continue;
    const base = Object.fromEntries(Object.entries(tool.shape).map(([k, v]) => [k, sample(k, v)]));
    delete base.validateOnly;
    const variants: Row[] = [base, { ...base, dateRange: undefined, days: 90 }];
    for (const [key, type] of Object.entries(tool.shape)) {
      for (const option of enumOptions(type) ?? []) variants.push({ ...base, [key]: option });
    }
    for (const args of variants) {
      const queries: string[] = [];
      const client = fakeClient(queries);
      const handlers: Handler[] = [];
      registerGoogleAdsTools(
        { registerTool: (n: string, _c: unknown, h: Handler) => { if (n === tool.name) handlers.push(h); } } as never,
        () => client as never,
        [],
        false
      );
      try {
        await handlers[0](args);
      } catch {
        // erro de negócio com dados falsos não interessa aqui; só as queries montadas
      }
      if (queries.length) withQueries.add(tool.name);
      for (const query of queries) {
        validated++;
        const errors = validateGaql(query);
        if (errors.length === 0) continue;
        if (!broken.has(tool.name)) broken.set(tool.name, new Set());
        for (const error of errors) broken.get(tool.name)!.add(error);
      }
    }
  }

  console.log(`varredura: ${tools.length} tools, ${withQueries.size} montaram GAQL, ${validated} queries validadas`);
  const unexpected = [...broken.entries()].filter(([name]) => !KNOWN_BROKEN.has(name));
  const report = unexpected.map(([name, errors]) => `${name}:\n  - ${[...errors].join("\n  - ")}`).join("\n");
  assert.equal(unexpected.length, 0, `Tools com GAQL inválido:\n${report}`);
  const fixed = [...KNOWN_BROKEN].filter((name) => !broken.has(name));
  assert.deepEqual(fixed, [], `Corrigidas — remova de KNOWN_BROKEN: ${fixed.join(", ")}`);
});
