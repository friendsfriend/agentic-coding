// argv surface + entrypoint wiring. Subcommand names/flags are the frozen external
// contract (agent skills, prompts, and the dashboard invoke them literally).
import * as effects from './effects.ts';
import * as orchestration from './orchestration.ts';
import * as plugins from './plugins.ts';
import * as transitions from './transitions.ts';

export const SUBCOMMANDS = [
  'projects', 'config', 'start', 'planner', 'apply', 'verify',
  'dispatch-verifiers', 'archive', 'close', 'status',
  'git-operations', 'phase', 'override-phase',
  'preflight-archive', 'set-return', 'verification-result', 'message', 'plugin',
  'finish-review',
] as const;

// subcommand -> required flag dests (positionals excluded)
export const REQUIRED_FLAGS: Record<string, string[]> = {
  start: ['repo', 'change', 'mode'],
  planner: ['repo', 'change'],
  apply: ['repo', 'change'],
  verify: ['repo', 'change'],
  'dispatch-verifiers': ['repo', 'change'],
  archive: ['repo', 'change'],
  close: ['repo', 'change'],
  status: ['repo', 'change'],
  'git-operations': ['repo', 'change'],
  phase: ['repo', 'change'],
  'override-phase': ['repo', 'change'],
  'preflight-archive': ['repo', 'change'],
  'set-return': ['repo', 'change', 'workspace'],
  'verification-result': ['repo', 'change', 'role'],
  message: ['repo', 'change', 'sender', 'target'],
};

export const WORKFLOW_TYPE_CHOICES = Object.keys(transitions.WORKFLOW_TYPES);
export const PLUGIN_SUBCOMMANDS = ['list', 'install', 'install-local'] as const;

// One-line usage + description per subcommand, shown by `--help`/`-h`. Kept next to
// REQUIRED_FLAGS/SUBCOMMANDS so drift is a one-file diff, not a hunt across docs.
const HELP: Record<string, { usage: string; summary: string }> = {
  projects: { usage: 'projects', summary: 'List discovered repositories under the configured projects root.' },
  config: { usage: 'config', summary: 'Print the resolved workflow config as JSON.' },
  start: {
    usage: 'start --repo <path> --change <id> --mode <worktree|checkout> [--workflow-type <standard|direct-apply|no-openspec>] [--task <text>] [--ticket <id>] [--worker <model>]',
    summary: 'Create the branch/worktree, Herdr workspace, and launch the first-phase role(s) for a new change.',
  },
  planner: { usage: 'planner --repo <path> --change <id>', summary: 'Restart the planner role during the explore phase.' },
  apply: { usage: 'apply --repo <path> --change <id>', summary: 'Run the plan-quality gate and start the worker role.' },
  verify: { usage: 'verify --repo <path> --change <id>', summary: 'Re-enter the verify phase (e.g. after a fix round).' },
  'dispatch-verifiers': { usage: 'dispatch-verifiers --repo <path> --change <id>', summary: 'Start the review-tier verifier roles for the current round.' },
  'finish-review': { usage: 'finish-review --repo <path> --change <id>', summary: 'Consolidate verifier verdicts and transition out of verify.' },
  archive: { usage: 'archive --repo <path> --change <id>', summary: 'Start the archive role after developer approval.' },
  close: { usage: 'close --repo <path> --change <id>', summary: 'Tear down the workflow (panes/tabs) after archive completes.' },
  status: { usage: 'status --repo <path> --change <id>', summary: 'Print the current state.json for the change.' },
  'git-operations': { usage: 'git-operations --repo <path> --change <id>', summary: 'Start the git-operations role to push/PR the finished change.' },
  phase: { usage: 'phase --repo <path> --change <id> <phase>', summary: 'Force-set the recorded phase without running its transition logic.' },
  'override-phase': { usage: 'override-phase --repo <path> --change <id> <phase>', summary: 'Operator escape hatch: jump the workflow to an arbitrary phase.' },
  'preflight-archive': { usage: 'preflight-archive --repo <path> --change <id>', summary: 'Validate archive preconditions (clean tree, tasks complete) without starting archive.' },
  'set-return': { usage: 'set-return --repo <path> --change <id> --workspace <id>', summary: 'Record the Herdr workspace to focus once the workflow closes.' },
  'verification-result': { usage: 'verification-result --repo <path> --change <id> --role <name>', summary: 'Record one verifier role\'s pass/fail verdict for the current round.' },
  message: { usage: 'message --repo <path> --change <id> --from <role> --to <role> <text>', summary: 'Deliver an inter-role message (e.g. PLAN_REJECTED) and act on it.' },
  plugin: { usage: 'plugin <list|install <source>|install-local <path>> [--worker] [--planner]', summary: 'List or install Pi extensions, optionally scoped to worker/planner roles.' },
};

function printTopHelp(): void {
  console.log('Usage: agentic-coding workflow <command> [flags]\n');
  console.log('Commands:');
  for (const name of SUBCOMMANDS) console.log(`  ${name.padEnd(22)} ${HELP[name]?.summary ?? ''}`);
  console.log('\nRun `agentic-coding workflow <command> --help` for a command\'s full usage.');
}

function printCommandHelp(command: string): void {
  const entry = HELP[command];
  console.log(`Usage: agentic-coding workflow ${entry?.usage ?? command}`);
  if (entry?.summary) console.log(entry.summary);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function requirePositional(argv: string[], command: string): string {
  const positional = argv.find(token => !token.startsWith('--'));
  if (positional === undefined) throw new Error(`${command}: missing required positional argument`);
  return positional;
}

function requireFlags(command: string, flags: Record<string, string | undefined>): void {
  for (const dest of REQUIRED_FLAGS[command] ?? []) {
    if (flags[dest] === undefined) throw new Error(`${command}: the --${dest} flag is required`);
  }
}

export function buildContext(): effects.Context {
  return { config: effects.loadConfig(), herdr: new effects.Herdr(), git: new effects.Git(), clock: new effects.Clock(), exporter: new effects.TraceExporter() };
}

export async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printTopHelp();
    return;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    if (command === 'plugin') {
      console.log(`Usage: agentic-coding workflow ${HELP.plugin.usage}`);
      console.log(HELP.plugin.summary);
    } else {
      printCommandHelp(command);
    }
    return;
  }
  const ctx = buildContext();
  const repo = flag(rest, 'repo');
  const change = flag(rest, 'change');

  switch (command) {
    case 'projects':
      orchestration.cmdProjects(ctx);
      return;
    case 'config':
      orchestration.cmdConfig(ctx);
      return;
    case 'start': {
      const mode = flag(rest, 'mode') as 'worktree' | 'checkout' | undefined;
      requireFlags(command, { repo, change, mode });
      const workflowType = flag(rest, 'workflow-type') ?? 'standard';
      if (!WORKFLOW_TYPE_CHOICES.includes(workflowType)) throw new Error(`invalid --workflow-type: ${workflowType}`);
      await orchestration.cmdStart(ctx, { repo, change, mode, task: flag(rest, 'task') ?? null, ticket: flag(rest, 'ticket') ?? null, worker: flag(rest, 'worker'), workflowType });
      return;
    }
    case 'planner':
      requireFlags(command, { repo, change });
      await orchestration.cmdPlanner(ctx, { repo, change });
      return;
    case 'apply':
      requireFlags(command, { repo, change });
      await orchestration.cmdApply(ctx, { repo, change });
      return;
    case 'verify':
      requireFlags(command, { repo, change });
      await orchestration.cmdVerify(ctx, { repo, change });
      return;
    case 'dispatch-verifiers':
      requireFlags(command, { repo, change });
      await orchestration.cmdDispatchVerifiers(ctx, { repo, change });
      return;
    case 'finish-review':
      requireFlags(command, { repo, change });
      await orchestration.cmdFinishReview(ctx, { repo, change });
      return;
    case 'archive':
      requireFlags(command, { repo, change });
      await orchestration.cmdArchive(ctx, { repo, change });
      return;
    case 'close':
      requireFlags(command, { repo, change });
      orchestration.cmdClose(ctx, { repo, change });
      return;
    case 'status':
      requireFlags(command, { repo, change });
      orchestration.cmdStatus(ctx, { repo, change });
      return;
    case 'git-operations':
      requireFlags(command, { repo, change });
      orchestration.cmdGitOperations(ctx, { repo, change });
      return;
    case 'phase': {
      requireFlags(command, { repo, change });
      const phase = requirePositional(rest, command);
      orchestration.cmdPhase(ctx, { repo, change, phase });
      return;
    }
    case 'override-phase': {
      requireFlags(command, { repo, change });
      const phase = requirePositional(rest, command);
      orchestration.cmdOverridePhase(ctx, { repo, change, phase });
      return;
    }
    case 'preflight-archive':
      requireFlags(command, { repo, change });
      orchestration.cmdPreflightArchive(ctx, { repo, change });
      return;
    case 'set-return': {
      const workspace = flag(rest, 'workspace');
      requireFlags(command, { repo, change, workspace });
      orchestration.cmdSetReturn(ctx, { repo, change, workspace });
      return;
    }
    case 'verification-result': {
      const role = flag(rest, 'role');
      requireFlags(command, { repo, change, role });
      await orchestration.cmdVerificationResult(ctx, { repo, change, role });
      return;
    }
    case 'message': {
      const sender = flag(rest, 'from');
      const target = flag(rest, 'to');
      requireFlags(command, { repo, change, sender, target });
      const text = requirePositional(rest, command);
      orchestration.cmdMessage(ctx, { repo, change, sender, target, text });
      return;
    }
    case 'plugin': {
      const [pluginCommand, ...pluginRest] = rest;
      if (!(PLUGIN_SUBCOMMANDS as readonly string[]).includes(pluginCommand)) {
        throw new Error(`unknown plugin subcommand: ${pluginCommand ?? '(none)'}`);
      }
      const worker = pluginRest.includes('--worker');
      const planner = pluginRest.includes('--planner');
      if (pluginCommand === 'list') {
        plugins.cmdPlugin(ctx.config, { pluginCommand: 'list' });
      } else if (pluginCommand === 'install') {
        plugins.cmdPlugin(ctx.config, { pluginCommand: 'install', source: requirePositional(pluginRest, 'plugin install'), worker, planner });
      } else {
        plugins.cmdPlugin(ctx.config, { pluginCommand: 'install-local', path: requirePositional(pluginRest, 'plugin install-local'), worker, planner });
      }
      return;
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await run(argv);
  } catch (error) {
    console.error((error as Error).message ?? String(error));
    process.exit(1);
  }
}
