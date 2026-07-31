// In-process bridge to the `agentic-coding` workflow engine — replaces
// `Bun.spawn(["herdr-workflow", …])` + JSON reparse for the dashboard's own
// calls. Agents still invoke the `herdr-workflow` shim unchanged (T4).
import { buildContext } from "../../workflow/cli.ts";
import * as orchestration from "../../workflow/orchestration.ts";
import type { Args } from "../../workflow/orchestration.ts";

/** Capture `console.log` output during a call, matching the text a CLI caller
 * would have read from the subprocess's stdout. */
function captureConsoleSync(fn: () => unknown): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
async function captureConsole(fn: () => unknown): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

const WORKFLOW_ACTIONS: Record<string, (ctx: ReturnType<typeof buildContext>, args: Args) => unknown> = {
  apply: orchestration.cmdApply,
  verify: orchestration.cmdVerify,
  "finish-review": orchestration.cmdFinishReview,
  archive: orchestration.cmdArchive,
  close: orchestration.cmdClose,
  "override-phase": orchestration.cmdOverridePhase,
};

/** In-process replacement for the dashboard's `Bun.spawn(["herdr-workflow", action, …])`. */
export async function runWorkflowAction(action: string, repo: string, change: string, argument?: string): Promise<string> {
  const handler = WORKFLOW_ACTIONS[action];
  if (!handler) throw new Error(`unknown workflow action: ${action}`);
  const args: Args = argument !== undefined ? { repo, change, phase: argument } : { repo, change };
  const output = await captureConsole(() => handler(buildContext(), args));
  return output || `${action} complete`;
}

/** Map the dashboard's "New workflow" form input to engine `Args` — kept
 * standalone so the mapping (esp. `quick` -> `no-openspec`) is unit-testable
 * without a real repo/herdr fixture. */
export function startArgs(input: { repo: string; ticket: string; change: string; task?: string; mode: string; worker: string; workflowType?: string }): Args {
  return {
    repo: input.repo,
    change: input.change,
    mode: input.mode as "worktree" | "checkout",
    worker: input.worker,
    workflowType: input.workflowType === "quick" ? "no-openspec" : (input.workflowType ?? "standard"),
    task: input.task || null,
    ticket: input.ticket || null,
  };
}

export async function startWorkflowInProcess(input: Parameters<typeof startArgs>[0] & { sshPassphrase?: string }): Promise<string> {
  if (input.sshPassphrase) process.env.HERDR_SSH_PASSPHRASE = input.sshPassphrase;
  const output = await captureConsole(() => orchestration.cmdStart(buildContext(), startArgs(input)));
  return output || "Workflow started";
}

export function setReturnInProcess(repo: string, change: string, workspace: string): void {
  orchestration.cmdSetReturn(buildContext(), { repo, change, workspace });
}

export function discoverProjectsInProcess(): Array<{ name: string; path: string; openspec: boolean }> {
  const output = captureConsoleSync(() => orchestration.cmdProjects(buildContext()));
  return output ? JSON.parse(output) : [];
}
