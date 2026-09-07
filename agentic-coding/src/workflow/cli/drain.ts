// Runs the effect-runner against every pending effect for a workflow, and
// the detached-process argv used to continue draining after a `--no-drain`
// handoff returns. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import { Herdr } from "../../herdr-client.ts";
import {
	type AgentAdapter,
	HerdrLifecycle,
	OpenCodeAdapter,
	OpenCodeV2Adapter,
	PiAdapter,
} from "../adapters.ts";
import type { CredentialPrompt } from "../credentials.ts";
import { agentEffectHandlers, EffectRunner } from "../effect-runner.ts";
import { dueQuestionTimers, type WorkflowEngine } from "../runtime.ts";
import { paneForRunFactory } from "./pane.ts";
import { registry } from "./registry.ts";

export const CONTINUATION_WAIT_MS = 65_000;
const DRAIN_POLL_MS = 1_000;

export async function drainEffects(
	workflowEngine: WorkflowEngine,
	repo: string,
	credentialPrompt?: CredentialPrompt,
	limit = 20,
	waitMs = 0,
	signal?: AbortSignal,
	onFailure?: (workflowId: string, message: string) => void,
): Promise<number> {
	const herdr = new Herdr();
	const lifecycle = new HerdrLifecycle(herdr);
	const adapters = new Map<string, AgentAdapter>([
		["pi", new PiAdapter(lifecycle)],
		["opencode", new OpenCodeAdapter(lifecycle)],
		["opencode-v2", new OpenCodeV2Adapter(lifecycle)],
	]);
	const handlers = agentEffectHandlers(repo, workflowEngine, {
		registry,
		adapters,
		herdr,
		credentialPrompt,
		paneForRun: paneForRunFactory(workflowEngine, repo, herdr),
	});
	const deadline = Date.now() + Math.max(0, waitMs);
	let completed = 0;
	do {
		if (signal?.aborted) break;
		completed += await new EffectRunner(repo, workflowEngine, handlers).drain(
			limit,
			30_000,
			signal,
			onFailure,
		);
		if (signal?.aborted) break;
		expireDueQuestionTimers(workflowEngine, repo, limit);
		if (Date.now() >= deadline) break;
		await Bun.sleep(Math.min(DRAIN_POLL_MS, deadline - Date.now()));
	} while (!signal?.aborted && Date.now() < deadline);
	return completed;
}

function expireDueQuestionTimers(
	workflowEngine: WorkflowEngine,
	repo: string,
	limit: number,
): void {
	for (const timer of dueQuestionTimers(repo, new Date(), limit)) {
		try {
			workflowEngine.dispatch(repo, {
				type: "timer.question-expire",
				workflowId: timer.workflowId,
				questionId: timer.questionId,
				timerNonce: timer.timerNonce,
			});
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/stale-question|no longer pending|invalid/.test(error.message)
			)
				throw error;
		}
	}
}

export function detachedDrainArgv(
	entry: string | undefined,
	repo: string,
	_workflowId?: string,
): string[] {
	return [
		process.execPath,
		...(entry ? [entry] : []),
		"workflow",
		"drain",
		"--repo",
		repo,
	];
}

/** Schedule bounded execution without making an observational read own it. */
export function scheduleDrain(
	repo: string,
	limit = 20,
	waitMs = CONTINUATION_WAIT_MS,
): void {
	const entry = Bun.main.startsWith("$bunfs") ? undefined : Bun.main;
	const argv = detachedDrainArgv(entry, repo);
	if (limit !== 20) argv.push("--limit", String(limit));
	argv.push("--wait-ms", String(waitMs));
	const safeKeys = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TERM",
		"LANG",
		"LC_ALL",
		"LC_MESSAGES",
		"HERDR_ENV",
		"HERDR_BIN_PATH",
		"HERDR_SOCKET_PATH",
		"HERDR_WORKFLOW_CONFIG",
		"HERDR_WIKI_DIR",
	];
	const env = Object.fromEntries(
		safeKeys.flatMap((key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
		),
	);
	const child = Bun.spawn(argv, {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		cwd: process.cwd(),
		env,
	});
	child.unref();
}
