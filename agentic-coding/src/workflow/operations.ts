// Application-operations boundary shared by the CLI surface and the TUI
// dashboard (enforce-source-layer-boundaries): the in-process engine factory,
// durable effect draining, project discovery, and the continuation constant.
// The CLI composes these operations into commands; the dashboard consumes
// them directly as an application client. Neither the CLI command modules nor
// the TUI presentation layers may import each other — both consume this
// boundary instead. Exact-edge function provenance:
//   - `engine` moved from cli/registry.ts (the process-lifetime registry
//     itself stays in the CLI layer)
//   - `drainEffects` + `CONTINUATION_WAIT_MS` moved from cli/drain.ts
//   - `listProjects` moved from cli/commands/misc.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { Herdr } from "../herdr-client.ts";
import {
	type AgentAdapter,
	HerdrLifecycle,
	OpenCodeAdapter,
	OpenCodeV2Adapter,
	PiAdapter,
} from "./adapters.ts";
import type { WorkflowApplication } from "./application.ts";
import { paneForRunFactory } from "./cli/pane.ts";
import { registry } from "./cli/registry.ts";
import type { CredentialPrompt } from "./credentials.ts";
import { agentEffectHandlers, EffectRunner } from "./effect-runner.ts";
import { loadConfig } from "./effects.ts";
import { dueQuestionTimers, WorkflowEngine } from "./runtime.ts";
export const CONTINUATION_WAIT_MS = 65_000;

/** The `WorkflowEngine` factory built from the process-lifetime builtin
 * registry. CLI commands and the dashboard coordinator both start engines
 * through this boundary; when a named application root is supplied the
 * engine consumes its root-owned layer instead of building a nested runtime
 * (complete-workflow-effect-cutover, task 1). */
export function engine(application?: WorkflowApplication): WorkflowEngine {
	return new WorkflowEngine(
		registry,
		application?.clock,
		undefined,
		application?.layerOf(),
	);
}

/** Runs the effect-runner against every pending effect for a workflow
 * within the given bounded wait budget. */
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
		// Drain through the Effect program directly (the Promise facade stays
		// only for test callers); the CLI/dashboard callers run this within
		// their owned application scope (complete-workflow-effect-cutover,
		// task 3.1).
		completed += await Effect.runPromise(
			new EffectRunner(repo, workflowEngine, handlers).drainProgram(
				limit,
				30_000,
				signal,
				onFailure,
			),
		);
		if (signal?.aborted) break;
		expireDueQuestionTimers(workflowEngine, repo, limit);
		if (Date.now() >= deadline) break;
		await Bun.sleep(Math.min(DRAIN_POLL_MS, deadline - Date.now()));
	} while (!signal?.aborted && Date.now() < deadline);
	return completed;
}

/** Every discovered project directory under the configured projects root. */
export function listProjects(): Array<{
	name: string;
	path: string;
	openspec: boolean;
}> {
	const config = loadConfig().projects;
	const root = path.resolve(String(config.root).replace(/^~/, os.homedir()));
	const found: Array<{ name: string; path: string; openspec: boolean }> = [];
	const walk = (directory: string, depth: number) => {
		if (depth > config.max_depth) return;
		try {
			if (!fs.existsSync(directory)) return;
			if (fs.existsSync(path.join(directory, ".git"))) {
				found.push({
					name: path.relative(root, directory) || ".",
					path: directory,
					openspec: fs.existsSync(
						path.join(directory, "openspec", "config.yaml"),
					),
				});
				return;
			}
			for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
				if (
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					!["node_modules", "dist", "build", "target"].includes(entry.name)
				)
					walk(path.join(directory, entry.name), depth + 1);
		} catch {
			return;
		}
	};
	walk(root, 0);
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

const DRAIN_POLL_MS = 1_000;

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
