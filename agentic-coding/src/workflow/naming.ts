import { createHash } from 'node:crypto';

// Workspace scopes names across repositories. Herdr limits names to 32 chars;
// hash only workspace IDs that do not fit or contain unsupported characters.
const HERDR_NAME_LIMIT = 32;
const HERDR_NAME = /^[a-z][a-z0-9_-]*$/;

export function agentName(workspaceId: string, role: string): string {
  const suffix = `-${role}`;
  const tokenLength = HERDR_NAME_LIMIT - suffix.length;
  if (tokenLength < 2) throw new Error(`role too long for Herdr agent name: ${role}`);
  const direct = `${workspaceId}${suffix}`;
  if (direct.length <= HERDR_NAME_LIMIT && HERDR_NAME.test(direct)) return direct;
  const token = `w${createHash('sha256').update(workspaceId).digest('hex').slice(0, tokenLength - 1)}`;
  return `${token}${suffix}`;
}
