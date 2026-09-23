import dotenv from "dotenv";
import { CREDENTIAL_ENV_VARS } from "./hosted-config.js";

/**
 * Completa `env` com as chaves do .env do projeto sem sobrescrever nada: o bloco env do
 * cliente MCP e o .env do cwd vencem. Credencial do arquivo só entra quando nenhuma foi
 * definida antes — duas credenciais diferentes derrubariam o boot ("Defina apenas uma
 * credencial"). Devolve as chaves aplicadas.
 */
export function fillFromProjectEnv(contents: string | Buffer, env: NodeJS.ProcessEnv): string[] {
  const credentialVars: readonly string[] = CREDENTIAL_ENV_VARS;
  const hasCredential = credentialVars.some((name) => (env[name] ?? "").trim() !== "");
  const applied: string[] = [];
  for (const [key, value] of Object.entries(dotenv.parse(contents))) {
    if (env[key] !== undefined) continue;
    if (hasCredential && credentialVars.includes(key)) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
