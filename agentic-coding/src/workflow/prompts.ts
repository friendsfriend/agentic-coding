// Pure(ish) prompt/argument building. Only local filesystem reads for extension/plugin
// discovery — no subprocess.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths.ts';
import * as naming from './naming.ts';
import { REPORT_CONTRACT } from './findings.ts';

export const UNRESTRICTED_ROLES = new Set(['planner', 'worker']);
export const ONE_SHOT_ROLES = new Set(['recovery', 'archive']);
// Herdr extensions loaded by explicit --extension flag, skip in discovery to avoid double-loading
export const HERDR_EXTENSIONS = new Set(['herdr-telemetry', 'herdr-workflow']);
export const PI_EXTENSION_DIRS = [path.join(paths.AGENT_DIR, 'extensions'), path.join(paths.AGENT_DEF_DIR, 'extensions'), path.join(os.homedir(), '.config', 'pi', 'extensions')];

export const ROLE_TOOLS: Record<string, string> = {
  planner: 'read,bash,edit,write',
  triage: 'read,bash,edit,write',
  recovery: 'read,bash,edit,write',
  worker: 'read,bash,edit,write',
  'security-verifier': 'read,bash',
  'agents-verifier': 'read,bash',
  'quality-verifier': 'read,bash',
  'performance-verifier': 'read,bash',
  'openspec-verifier': 'read,bash',
  'test-verifier': 'read,bash',
  'usability-verifier': 'read,bash',
  archive: 'read,bash',
};

export function isOneShot(role: string): boolean {
  return ONE_SHOT_ROLES.has(role);
}

export function roleEnv(role: string, change: string): string[] {
  return ['--env', `HERDR_ROLE=${role}`, '--env', `HERDR_CHANGE_ID=${change}`];
}

/** Discover all extension files from standard pi locations. */
export function discoverExtensions(): Record<string, string> {
  const extensions: Record<string, string> = {};
  for (const directory of PI_EXTENSION_DIRS) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;
    for (const entry of fs.readdirSync(directory).sort()) {
      const ext = path.extname(entry);
      if (['.ts', '.js', '.mjs'].includes(ext)) {
        const name = path.basename(entry, ext);
        if (!(name in extensions)) extensions[name] = path.join(directory, entry);
      }
    }
  }
  return extensions;
}

/** Load plugin-assignments.json if it exists. */
export function loadPluginAssignments(): { plugins: Array<{ source: string; agentRoles: string[] }> } {
  const p = path.join(paths.AGENT_DIR, 'plugin-assignments.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      console.log(`warning: corrupt ${p}, starting fresh`);
    }
  }
  return { plugins: [] };
}

/** Save plugin-assignments.json. */
export function savePluginAssignments(assignments: unknown): void {
  const p = path.join(paths.AGENT_DIR, 'plugin-assignments.json');
  fs.writeFileSync(p, JSON.stringify(assignments, null, 2) + '\n');
}

/** Resolve excluded extension names for a given role. */
export function resolveExclusions(config: any, role: string): Set<string> {
  const excluded = new Set<string>();
  const plugins = config?.plugins ?? {};
  if (plugins.exclude_extensions) for (const name of plugins.exclude_extensions) excluded.add(name);
  const roleConfig = plugins.roles?.[role] ?? {};
  if (roleConfig.exclude_extensions) for (const name of roleConfig.exclude_extensions) excluded.add(name);
  return excluded;
}

export function rolePrompt(role: string, change: string, verificationRound?: number | null, workflowType?: string | null, task?: string | null): string {
  const request = `.herdr-workflow/${change}/request.md`;
  const restricted =
    ' Complete assigned role in this Pi process then stop — do not stay active waiting for next step. You will be notified when needed again. Do not invoke another agent executable or invoke another agent or pane. Use herdr-workflow for required workflow handoff exactly as specified.';
  const persistent =
    " Complete this round in this Pi process, then go idle and wait in this same process for the next round's prompt — do not exit, restart, or start unrelated work. Do not invoke another agent executable or invoke another agent or pane. Use herdr-workflow for required workflow handoff exactly as specified.";

  if (role === 'planner') {
    return `Planner for OpenSpec change ${change}. Read ${request}, explore repository context, and discuss unclear requirements with developer. When asked to propose, use openspec instructions proposal/design/tasks/specs --change ${change} as the artifact contract, then write proposal, design, tasks, and delta spec scenarios under openspec/changes/${change}/ and run openspec validate ${change} --strict. Do not call generic OpenSpec help or inspect archived changes solely to learn artifact structure. Submit with herdr-workflow phase proposed --repo . --change ${change}; fix PLAN_REJECTED feedback before finishing.`;
  }
  if (role === 'worker') {
    if (workflowType === 'no-openspec') {
      const description = task ? ` Implement this change: ${task}` : '';
      return `Worker for ${change}. Use chat for scope, progress, and blockers. Run focused tests only; quality and test verifiers own remaining validation gates. No task checklist to read — signal completion by running herdr-workflow verify --repo . --change ${change} once the change is applied. Output containing \`triage started:\` or \`verification already running:\` means handoff succeeded: stop immediately and never invoke verify again; do not poll status, call workflow help, inspect downstream workflow files, or wait with more tool calls. If a workflow phase/base/state blocker rejects it, report the exact blocker in chat and stop; never inspect workflow implementation source or read/change .herdr-workflow state (herdr.db).${description}`;
    }
    return `Worker for ${change}. Follow loaded skill and use chat for scope, progress, and blockers. Apply approved plan. Run focused tests only; quality and test verifiers own remaining validation gates. Mark each OpenSpec task [x] only after focused validation; verification rejects unfinished tasks. Output containing \`triage started:\` or \`verification already running:\` means handoff succeeded: stop immediately and never invoke verify again; do not poll status, call workflow help, inspect downstream workflow files, or wait with more tool calls. If a workflow phase/base/state blocker rejects it, report the exact blocker in chat and stop; never inspect workflow implementation source or read/change .herdr-workflow state (herdr.db).`;
  }
  if (role === 'triage') {
    const reviews = `.herdr-workflow/${change}/reviews`;
    return (
      `Silent triage for round ${verificationRound}. Read ${reviews}/round-${verificationRound}-triage-input.json only. Select minimum needed reviewers and assign relevant files or hunks. Do not select agents-verifier merely because AGENTS.md/CLAUDE.md applies; use it only when an instruction file changed or material tooling, environment, layout, or mandatory-command changes may require instruction updates. Write ${reviews}/round-${verificationRound}-triage.json, then run herdr-workflow dispatch-verifiers --repo . --change ${change}. No chat output.` +
      persistent
    );
  }
  const verifierFocus: Record<string, string> = {
    'security-verifier': 'Review changed trust boundaries for introduced injection, auth, secret, crypto, and input-validation defects.',
    'agents-verifier': 'Check changed code only against applicable AGENTS.md and CLAUDE.md instructions.',
    'quality-verifier': 'Run focused formatting, lint, and type checks; review changed code for concrete correctness and maintainability defects. Do not run any tests — test execution and coverage are the test verifier\'s domain.',
    'performance-verifier': 'Review changed hot paths for measurable query, I/O, CPU, blocking, and memory regressions.',
    'openspec-verifier': 'Compare implementation against approved proposal, design, specs, and tasks for missing, incompatible, or out-of-scope behavior.',
    'usability-verifier': 'Review changed frontend and asset files for introduced visual consistency, accessibility, responsive layout, design-system, component-state, and hardcoded-style defects.',
    'test-verifier': "Run the repository's complete configured test suite once without filters; do not rerun changed tests already covered. PASS requires success or only confirmed pre-existing unrelated failures. Reuse prior baseline evidence from context; one focused baseline reproduction is allowed only for a new apparently unrelated full-suite failure.",
  };
  const verifierLabel: Record<string, string> = {
    'security-verifier': 'security verifier',
    'agents-verifier': 'AGENTS instructions verifier',
    'quality-verifier': 'code quality verifier',
    'performance-verifier': 'performance verifier',
    'openspec-verifier': 'OpenSpec verifier',
    'usability-verifier': 'usability verifier',
    'test-verifier': 'full-suite test verifier',
  };
  if (role in verifierFocus) {
    const context = `.herdr-workflow/${change}/reviews/round-${verificationRound}-${role}-context.md`;
    const report = `.herdr-workflow/${change}/reviews/round-${verificationRound}-${role}.findings.jsonl`;
    const reviewOnly = !['quality-verifier', 'test-verifier'].includes(role)
      ? ' Review only; do not run tests, formatting, lint, type, or build commands. Treat generated context as authoritative scope: no full-repository git diff or unrelated changed-file inspection; read full assigned files or direct dependencies only when needed to understand a scoped hunk.'
      : '';
    return (
      `Silent ${verifierLabel[role]} for ${change} round ${verificationRound}. Read ${context}. ${verifierFocus[role]}${reviewOnly} ${REPORT_CONTRACT} Write the report to ${report}, then run herdr-workflow verification-result --repo . --change ${change} --role ${role}. No chat output. Only report actual defects and issues. Do not include findings that merely confirm code was implemented correctly — if nothing is wrong, write only the PASS verdict with no findings.` +
      persistent
    );
  }
  if (role === 'archive') {
    return (
      `Silent archive agent for OpenSpec change ${change}. Read .herdr-workflow/${change}/reviews/archive-context.md only; do not read review history or telemetry. Follow its archive instructions, then run herdr-workflow archive --repo . --change ${change}. No chat output.` +
      restricted
    );
  }
  if (role === 'recovery') {
    return (
      `Silent recovery agent for ${change}. Read .herdr-workflow/${change}/reviews/recovery-context.json. Write .herdr-workflow/${change}/reviews/recovery-plan.json with matching recoveryId and exactly one allowlisted action: retry-verification, dispatch-triage, or record-verifier-result (include role). Do not execute plan, mutate state, commit, push, or archive. No chat output.` +
      restricted
    );
  }
  throw new Error(`unknown role: ${role}`);
}

/** Build Pi arguments for a Herdr-managed role agent. */
export function piArguments(role: string, model: string, thinking: string, change: string, config: any): string[] {
  const skill = path.join(paths.SKILLS, `herdr-openspec-${role}`, 'SKILL.md');
  const tools = ROLE_TOOLS[role];
  const parts = ['--name', naming.agentName(change, role), '--model', model, '--thinking', thinking];
  const telemetryExt = path.join(paths.AGENT_DEF_DIR, 'extensions', 'herdr-telemetry.ts');
  const workflowExt = path.join(paths.AGENT_DEF_DIR, 'extensions', 'herdr-workflow.ts');

  if (UNRESTRICTED_ROLES.has(role)) {
    const exclusions = resolveExclusions(config, role);
    if (exclusions.size) {
      parts.push('--no-extensions');
      parts.push('--extension', telemetryExt);
      parts.push('--extension', workflowExt);
      for (const [name, extPath] of Object.entries(discoverExtensions())) {
        if (!exclusions.has(name) && !HERDR_EXTENSIONS.has(name)) parts.push('--extension', extPath);
      }
    } else {
      parts.push('--extension', telemetryExt);
      parts.push('--extension', workflowExt);
    }
    parts.push('--no-prompt-templates', '--skill', skill);
  } else {
    parts.push('--tools', tools, '--no-extensions', '--extension', telemetryExt, '--extension', workflowExt, '--no-prompt-templates', '--no-skills', '--skill', skill);
  }

  if (isOneShot(role)) parts.push('--no-session');
  if (role === 'archive') parts.push('--no-context-files');
  return parts;
}
