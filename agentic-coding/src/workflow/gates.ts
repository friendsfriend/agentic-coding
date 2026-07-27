// Pure plan-quality and task-completion gate logic. Filesystem reads stay at the call site.

export interface PlanQualityResult {
  passed: boolean;
  issues: string[];
}

export function evaluatePlanQuality(missingNames: string[], hasSpecs: boolean, taskCount: number): PlanQualityResult {
  const issues = missingNames.map(name => `missing or empty ${name}.md`);
  if (!hasSpecs) issues.push('missing spec scenarios');
  if (!taskCount) issues.push('tasks.md has no actionable tasks');
  return { passed: issues.length === 0, issues };
}

export function countTasks(tasksText: string): number {
  const matches = tasksText.match(/^\s*[-*]\s+\[.\]/gm);
  return matches ? matches.length : 0;
}

export function incompleteTasks(tasksText: string): { tasks: Array<[string, string]>; incomplete: string[] } {
  const tasks: Array<[string, string]> = [];
  const re = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tasksText)) !== null) {
    tasks.push([match[1], match[2]]);
  }
  return { tasks, incomplete: tasks.filter(([mark]) => mark === ' ').map(([, text]) => text) };
}
