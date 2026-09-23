/**
 * Grupos de tools (GOOGLE_ADS_TOOL_GROUPS).
 *
 * O catálogo completo passa de 300 tools e o tools/list de 600 KB — alguns clientes MCP
 * carregam todas as definições no contexto do modelo. Com GOOGLE_ADS_TOOL_GROUPS o servidor
 * publica só os grupos pedidos: "core" (as tools de src/tools.ts) e as áreas de src/tools/.
 * Sem a variável (ou "all"), publica tudo — o comportamento de antes.
 */

import { MODULE_KEYS, MODULE_OF_TOOL } from "./tools/catalogs.js";

export const TOOL_GROUP_KEYS: string[] = ["core", ...MODULE_KEYS];

export function toolGroupOf(toolName: string): string {
  return MODULE_OF_TOOL[toolName] ?? "core";
}

/** null = todas as tools. Grupo desconhecido derruba o boot com a lista dos válidos. */
export function parseToolGroups(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "all") return null;
  const groups = [...new Set(raw.split(",").map((group) => group.trim()).filter(Boolean))];
  const unknown = groups.filter((group) => !TOOL_GROUP_KEYS.includes(group));
  if (unknown.length > 0) {
    throw new Error(
      `GOOGLE_ADS_TOOL_GROUPS: grupo(s) desconhecido(s) ${unknown.join(", ")}. Grupos válidos: ${TOOL_GROUP_KEYS.join(", ")} (ou all).`
    );
  }
  return groups;
}

/** Filtra o registerTool pelos grupos pedidos (como o filtro de read-only, compõe com ele). */
export function createToolGroupServer<T extends object>(server: T, groups: string[] | null): T {
  if (!groups) return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      const registerTool = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (name: string, ...args: unknown[]) => {
        if (!groups.includes(toolGroupOf(name))) return undefined;
        return Reflect.apply(registerTool, target, [name, ...args]);
      };
    },
  });
}
