// Pure workflow composition: modules, types, and allowed phase transitions.

export const OPERATIONAL_PHASES = [
  'explore',
  'proposed',
  'apply',
  'fix',
  'triage',
  'verify',
  'paused',
  'developer-review',
  'committing',
  'archive',
  'completed',
] as const;

export interface WorkflowModule {
  entry: string;
  exit: string;
  roles: string[];
  gate: boolean;
  phases: Set<string>;
}

// Module-based workflow composition
export const WORKFLOW_MODULES: Record<string, WorkflowModule> = {
  plan: { entry: 'explore', exit: 'proposed', roles: ['planner'], gate: false, phases: new Set(['explore']) },
  'plan-approval': { entry: 'proposed', exit: 'apply', roles: [], gate: true, phases: new Set(['proposed']) },
  'apply-verify': {
    entry: 'apply',
    exit: 'developer-review',
    roles: ['worker'],
    gate: false,
    phases: new Set(['apply', 'verify', 'fix', 'paused', 'triage']),
  },
  'developer-approval': { entry: 'developer-review', exit: 'archive', roles: [], gate: true, phases: new Set(['developer-review']) },
  archive: { entry: 'archive', exit: 'committing', roles: ['archive'], gate: false, phases: new Set(['archive']) },
  'git-operations': { entry: 'committing', exit: 'completed', roles: [], gate: false, phases: new Set(['committing']) },
};

export const WORKFLOW_TYPES: Record<string, string[]> = {
  standard: ['plan', 'plan-approval', 'apply-verify', 'developer-approval', 'archive', 'git-operations'],
  'direct-apply': ['apply-verify', 'developer-approval', 'archive', 'git-operations'],
  'no-openspec': ['apply-verify', 'developer-approval', 'git-operations'],
};

export function resolveModules(state: { workflowModules?: string[] | null }): string[] {
  return state.workflowModules ?? [...WORKFLOW_TYPES.standard];
}

export function allowedTransitions(state: { workflowModules?: string[] | null }): Record<string, Set<string>> {
  const modules = resolveModules(state);
  const allowed: Record<string, Set<string>> = {};
  const ensure = (phase: string) => (allowed[phase] ??= new Set());
  modules.forEach((name, i) => {
    const module = WORKFLOW_MODULES[name];
    for (const phase of module.phases) ensure(phase);
    if (name === 'apply-verify') {
      ensure('apply').add('verify');
      ensure('verify').add('fix').add('paused');
      ensure('fix').add('verify');
      ensure('paused').add('fix').add('verify');
    }
    if (!module.gate) {
      if (i + 1 < modules.length) {
        const nextEntry = WORKFLOW_MODULES[modules[i + 1]].entry;
        const source = name === 'apply-verify' ? 'verify' : [...module.phases][0];
        ensure(source).add(nextEntry);
      } else if (!module.phases.has(module.exit)) {
        const source = [...module.phases][0];
        ensure(source).add(module.exit);
      }
    }
  });
  return allowed;
}
