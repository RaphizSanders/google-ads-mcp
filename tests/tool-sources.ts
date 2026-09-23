/**
 * Código-fonte das tools: src/tools.ts (núcleo) e os módulos em src/tools/. Os testes que
 * conferem garantias no fonte (guarda de conta, classificação) leem por aqui para cobrir
 * também as tools dos módulos.
 */

import { readdirSync, readFileSync } from "node:fs";

export function toolSourceFiles(): string[] {
  const moduleDir = new URL("../src/tools/", import.meta.url);
  const modules = readdirSync(moduleDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".catalog.ts") && f !== "index.ts" && f !== "catalogs.ts")
    .map((f) => readFileSync(new URL(f, moduleDir), "utf8"));
  return [readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8"), ...modules];
}

/** Nome da tool → trecho do fonte que a implementa. */
export function toolImplementations(): Map<string, string> {
  const slices = new Map<string, string>();
  for (const source of toolSourceFiles()) {
    const starts = [...source.matchAll(/mcp\.registerTool\(\s*\n?\s*["']([^"']+)["']/g)];
    starts.forEach((start, index) => {
      slices.set(start[1], source.slice(start.index, starts[index + 1]?.index ?? source.length));
    });
  }
  return slices;
}
