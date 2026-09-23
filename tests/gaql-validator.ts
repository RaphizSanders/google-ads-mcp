/**
 * Validador de GAQL contra os metadados reais da API (tests/fixtures/google-ads-v25-fields.json,
 * extraído da field reference oficial por scripts/scrape-gaql-fields.py).
 *
 * Um client falso aceita qualquer query; foi assim que queries inválidas passaram pelos
 * testes mais de uma vez (campo inexistente, segmento incompatível com o FROM, recurso de
 * segmentação no WHERE sem estar no SELECT). Toda query que um teste enxerga passa por aqui.
 *
 * Regras verificadas:
 * - o recurso do FROM existe;
 * - cada campo existe e pertence ao FROM, a um recurso atribuído ou de segmentação dele,
 *   ou é um segmento/métrica compatível com aquele FROM;
 * - SELECT só com campos selecionáveis, WHERE só com filtráveis, ORDER BY só com ordenáveis;
 * - campo de recurso de segmentação ou segmento (exceto os de data) usado no WHERE precisa
 *   estar no SELECT.
 */

import { readFileSync } from "node:fs";

interface ResourceMeta {
  attributed: string[];
  segmenting: string[];
  segments: string[];
  metrics: string[];
}

interface FieldsFixture {
  version: string;
  resources: Record<string, ResourceMeta>;
  fields: Record<string, string>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/google-ads-v25-fields.json", import.meta.url), "utf8")
) as FieldsFixture;

/** Segmentos de data que podem ir no WHERE sem estar no SELECT. */
const CORE_DATE_SEGMENTS = new Set(["date", "week", "month", "quarter", "year"]);

const FIELD_TOKEN = /\b([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)+)\b/g;

/** Remove literais de string (com escapes) para não confundir 'www.site.com' com campo. */
function stripStrings(clause: string): string {
  return clause.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
}

function fieldsIn(clause: string): string[] {
  return [...stripStrings(clause).matchAll(FIELD_TOKEN)].map((m) => m[1]);
}

interface ParsedQuery {
  select: string[];
  from: string;
  where: string[];
  orderBy: string[];
}

export function parseGaql(query: string): ParsedQuery {
  const q = query.replace(/\s+/g, " ").trim();
  const upper = q.toUpperCase();
  const at = (keyword: string) => {
    const match = new RegExp(`\\b${keyword}\\b`).exec(upper);
    return match ? match.index : -1;
  };
  const selectAt = at("SELECT");
  const fromAt = at("FROM");
  if (selectAt !== 0 || fromAt < 0) throw new Error(`query sem SELECT ... FROM: ${q}`);
  const clauseEnds = ["WHERE", "ORDER BY", "LIMIT", "PARAMETERS"].map(at).filter((i) => i > fromAt);
  const fromEnd = clauseEnds.length ? Math.min(...clauseEnds) : q.length;
  const whereAt = at("WHERE");
  const orderAt = at("ORDER BY");
  const whereEnd = [orderAt, at("LIMIT"), at("PARAMETERS")].filter((i) => i > whereAt);
  const orderEnd = [at("LIMIT"), at("PARAMETERS")].filter((i) => i > orderAt);
  return {
    select: q.slice(6, fromAt).split(",").map((f) => f.trim()).filter(Boolean),
    from: q.slice(fromAt + 4, fromEnd).trim(),
    where: whereAt > fromAt ? fieldsIn(q.slice(whereAt + 5, whereEnd.length ? Math.min(...whereEnd) : q.length)) : [],
    orderBy: orderAt > fromAt ? fieldsIn(q.slice(orderAt + 8, orderEnd.length ? Math.min(...orderEnd) : q.length)) : [],
  };
}

/** Devolve a lista de erros da query (vazia = válida). */
export function validateGaql(query: string): string[] {
  let parsed: ParsedQuery;
  try {
    parsed = parseGaql(query);
  } catch (err) {
    return [(err as Error).message];
  }
  const errors: string[] = [];
  const resource = fixture.resources[parsed.from];
  if (!resource) return [`FROM ${parsed.from}: recurso não existe na ${fixture.version}`];

  const allowedPrefixes = new Set([parsed.from, ...resource.attributed, ...resource.segmenting]);
  const segmentingPrefixes = new Set(resource.segmenting);
  const selected = new Set(parsed.select);

  const check = (field: string, clause: "SELECT" | "WHERE" | "ORDER BY") => {
    const [prefix, ...rest] = field.split(".");
    const name = rest.join(".");
    if (prefix === "segments") {
      if (!resource.segments.includes(name)) {
        errors.push(`${clause}: segments.${name} não é compatível com FROM ${parsed.from}`);
        return;
      }
    } else if (prefix === "metrics") {
      if (!resource.metrics.includes(name)) {
        errors.push(`${clause}: metrics.${name} não é compatível com FROM ${parsed.from}`);
        return;
      }
    } else if (!allowedPrefixes.has(prefix)) {
      errors.push(`${clause}: ${field} — ${prefix} não é atribuído nem de segmentação para FROM ${parsed.from}`);
      return;
    }
    const flags = fixture.fields[field];
    if (flags === undefined) {
      errors.push(`${clause}: campo ${field} não existe na ${fixture.version}`);
      return;
    }
    if (clause === "SELECT" && !flags.includes("S")) errors.push(`SELECT: ${field} não é selecionável`);
    if (clause === "WHERE" && !flags.includes("F")) errors.push(`WHERE: ${field} não é filtrável`);
    if (clause === "ORDER BY" && !flags.includes("O")) errors.push(`ORDER BY: ${field} não é ordenável`);
  };

  for (const field of parsed.select) check(field, "SELECT");
  for (const field of parsed.where) {
    check(field, "WHERE");
    const [prefix, name] = [field.split(".")[0], field.split(".").slice(1).join(".")];
    const mustBeSelected = segmentingPrefixes.has(prefix) || (prefix === "segments" && !CORE_DATE_SEGMENTS.has(name));
    if (mustBeSelected && !selected.has(field)) {
      errors.push(`WHERE: ${field} precisa estar no SELECT (${prefix === "segments" ? "segmento" : "recurso de segmentação"} de FROM ${parsed.from})`);
    }
  }
  for (const field of parsed.orderBy) check(field, "ORDER BY");
  return [...new Set(errors)];
}

export const GAQL_FIXTURE_VERSION = fixture.version;
