// Plan-quality and task-completion gates with their filesystem reads. Pure gate
// math lives in gates.ts; this module owns the openspec/ path lookups.
import fs from 'node:fs';
import path from 'node:path';
import * as gates from './gates.ts';
import type { WorkflowState } from './state.ts';

export function planQuality(state: WorkflowState): gates.PlanQualityResult & { specFiles: number; taskCount: number } {
  const root = path.join(state.worktree, 'openspec', 'changes', state.changeId);
  const required: Record<string, string> = { proposal: path.join(root, 'proposal.md'), design: path.join(root, 'design.md'), tasks: path.join(root, 'tasks.md') };
  const missing = Object.keys(required).filter(name => !fs.existsSync(required[name]) || !fs.readFileSync(required[name], 'utf8').trim());
  const specsDir = path.join(root, 'specs');
  const specs = fs.existsSync(specsDir) ? findMarkdownFiles(specsDir) : [];
  const taskCount = !missing.includes('tasks') ? gates.countTasks(fs.readFileSync(required.tasks, 'utf8')) : 0;
  const result = gates.evaluatePlanQuality(missing, specs.length > 0, taskCount);
  return { ...result, specFiles: specs.length, taskCount };
}

export function findMarkdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

export function ensureTasksComplete(state: WorkflowState): void {
  const p = path.join(state.worktree, 'openspec', 'changes', state.changeId, 'tasks.md');
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`missing OpenSpec tasks: ${p}`);
  const { tasks, incomplete } = gates.incompleteTasks(fs.readFileSync(p, 'utf8'));
  if (!tasks.length) throw new Error(`no OpenSpec tasks found: ${p}`);
  if (incomplete.length) {
    throw new Error(`verification requires completed OpenSpec tasks; ${incomplete.length} remain in ${p}. Mark each implemented task [x] after focused validation.`);
  }
}
