import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Assignment } from './contracts.ts';
import type { StepDefinition } from './registry.ts';
import { AGENT_DEF_DIR } from './paths.ts';

export const MAX_ASSIGNMENT_BYTES = 96 * 1024;
export interface RenderedAssignment { prompt: string; digest: string; bytes: number }
function readPinnedAsset(name: string, expected: string, assetRoot: string): string {
  const root = fs.realpathSync(assetRoot);
  const candidate = path.resolve(root, name);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`instruction asset escapes root: ${name}`);
  const stat = fs.lstatSync(candidate); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid instruction asset: ${name}`);
  const content = fs.readFileSync(candidate, 'utf8');
  const actual = createHash('sha256').update(content).digest('hex'); if (actual !== expected) throw new Error(`instruction pin mismatch: ${name}`);
  return content.trim();
}
export function renderAssignment(step: Readonly<StepDefinition>, assignment: Assignment, assetRoot = path.join(AGENT_DEF_DIR, 'instructions')): RenderedAssignment {
  if (assignment.stepId !== step.id || !assignment.runId || !assignment.role || !assignment.objective.trim()) throw new Error('invalid assignment identity');
  const protocolIndex = step.instructionAssets.indexOf('workflow-agent-protocol.md'); if (protocolIndex < 0) throw new Error('missing pinned workflow protocol');
  const protocol = readPinnedAsset('workflow-agent-protocol.md', step.instructionDigests[protocolIndex]!, assetRoot);
  const protocolHash = createHash('sha256').update(protocol).digest('hex');
  const roleAsset = assignment.role.replace(/-verifier$/, '');
  const assets = step.instructionAssets.flatMap((name, index) => name === 'workflow-agent-protocol.md' ? [] : name === 'verification.md' || !name.startsWith('verification-') || name === `verification-${roleAsset}.md` ? [readPinnedAsset(name, step.instructionDigests[index]!, assetRoot)] : []);
  const handoff = 'agentic-coding workflow handoff --outcome complete' + (assignment.output ? ' --artifact "$HERDR_OUTPUT"' : '');
  const payloadExample = assignment.output?.schemaId === 'core.triage-plan' ? { roles: [{ role: 'quality-verifier', reason: 'why this role is needed', files: ['relative/path.ts'] }] } : assignment.output?.schemaId === 'core.findings' ? { findings: [{ id: 'ROLE-001', severity: 'critical', detail: 'actionable finding', path: 'relative/path.ts' }] } : { result: 'step-specific JSON value' };
  const envelope = assignment.output ? JSON.stringify({ runId: assignment.runId, schemaId: assignment.output.schemaId, schemaVersion: assignment.output.schemaVersion, payload: payloadExample }, null, 2) : undefined;
  const dynamic = [
    '# Run assignment', '', `Protocol: ${assignment.protocolVersion}`, `Workflow: ${assignment.workflowId}`, `Run: ${assignment.runId}`, `Generation: ${assignment.generation}`, `Step: ${assignment.stepId}`, `Role: ${assignment.role}`,
    '', '## Objective', assignment.objective, '', `Interaction: ${assignment.interaction}`, '', '## Inputs', ...(assignment.inputs.length ? assignment.inputs.map(item => `- ${item}`) : ['- none']),
    '', '## Permissions', ...assignment.permissions.map(item => `- ${item}`), '', '## Required checks', ...assignment.checks.map(item => `- ${item}`),
    '', '## Output contract', ...(assignment.output ? [`Path: ${assignment.output.path}`, `Schema: ${assignment.output.schemaId}@${assignment.output.schemaVersion}`, `Maximum bytes: ${assignment.output.maxBytes}`, 'Write exactly this envelope shape:', '```json', envelope!, '```', ...(assignment.output.schemaId === 'core.triage-plan' ? ['Payload: `roles` array; each item requires string `role`, non-empty string `reason`, and non-empty repository-relative string array `files`; optional `hunks` maps files to hunk IDs 1..8.'] : assignment.output.schemaId === 'core.findings' ? ['Payload: `findings` array; each item requires unique string `id`, `severity` (`critical`, `warning`, or `info`), non-empty string `detail`, and optional repository-relative `path`.'] : ['Payload: JSON value required by step instructions.'])] : ['No output artifact.']),
    '', `Allowed outcomes: ${assignment.allowedOutcomes.join(', ')}`, '', '## Constrained runtime tools', 'Read-only profiles must use `herdr_check` for Git inspection and isolated allowlisted checks; it never runs checkers in the authoritative worktree.', '', '## Handoff', 'Use `herdr_handoff` when available; it is required for read-only profiles and accepts `outcome`, optional output `payload`, and optional `message`.', 'Shell fallback:', '```bash', handoff, 'agentic-coding workflow handoff --outcome blocked --message "reason"', 'agentic-coding workflow handoff --outcome failed --message "diagnostic"', '```',
  ].join('\n');
  const prompt = [protocol, ...assets, dynamic].join('\n\n---\n\n');
  const bytes = Buffer.byteLength(prompt); if (bytes > MAX_ASSIGNMENT_BYTES) throw new Error(`assignment exceeds ${MAX_ASSIGNMENT_BYTES} bytes`);
  return { prompt, bytes, digest: createHash('sha256').update(`${protocolHash}\0${prompt}`).digest('hex') };
}
