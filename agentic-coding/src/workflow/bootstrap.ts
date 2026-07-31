// Per-workflow agent-definition injection for compiled binaries. The embedded
// snapshot of skills + extensions is materialized into the workflow's own
// `.herdr-workflow/<change>/agent-definitions/` directory — only that workflow's
// agents ever reference these files. Nothing is installed into the user's
// global pi setup (~/.pi/agent) or any user-global location. Source runs and
// explicit HERDR_AGENT_DEF_DIR overrides skip materialization entirely.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_DEFINITIONS, AGENT_DEFINITION_VERSION } from './embedded.generated.ts';
import { AGENT_DEF_DIR, isCompiled } from './paths.ts';

function marker(target: string): string {
  return path.join(target, '.version');
}

/** True when the directory is missing or belongs to an older binary snapshot. */
function stale(target: string): boolean {
  return !fs.existsSync(marker(target)) || fs.readFileSync(marker(target), 'utf8') !== AGENT_DEFINITION_VERSION;
}

/** Idempotent, versioned extraction of the bundled agent-definitions. */
function materialize(targetDir: string): void {
  if (!stale(targetDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, content] of Object.entries(AGENT_DEFINITIONS)) {
    const target = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  // Marker last: an interrupted extraction leaves a stale marker and re-runs next time.
  fs.writeFileSync(marker(targetDir), AGENT_DEFINITION_VERSION);
}

/**
 * Return the agent-definitions dir for one workflow's agents. Compiled binaries
 * materialize the embedded snapshot into the workflow's own `.herdr-workflow/`
 * dir (gitignored, workflow-scoped); source runs and HERDR_AGENT_DEF_DIR
 * overrides return the existing definitions unchanged.
 */
export function ensureWorkflowAgentDefinitions(worktree: string, change: string): string {
  if (!isCompiled() || process.env.HERDR_AGENT_DEF_DIR) return AGENT_DEF_DIR;
  const dir = path.join(worktree, '.herdr-workflow', change, 'agent-definitions');
  materialize(dir);
  return dir;
}
