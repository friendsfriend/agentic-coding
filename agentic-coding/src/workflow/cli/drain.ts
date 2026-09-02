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
import { loadConfig } from "../effects.ts";
import type { WorkflowEngine } from "../runtime.ts";
import { paneForRunFactory } from "./pane.ts";
import { registry } from "./registry.ts";

export async function drainEffects(
	workflowEngine: WorkflowEngine,
	repo: string,
	credentialPrompt?: CredentialPrompt,
): Promise<void> {
	const config = loadConfig();
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
		remote: config.workflow.remote,
		prTool: config.workflow.pr_tool,
		credentialPrompt,
		paneForRun: paneForRunFactory(workflowEngine, repo, herdr),
	});
	await new EffectRunner(repo, workflowEngine, handlers).drain();
}

export function detachedDrainArgv(
	entry: string | undefined,
	repo: string,
	workflowId: string,
): string[] {
	return [
		process.execPath,
		...(entry ? [entry] : []),
		"workflow",
		"status",
		"--repo",
		repo,
		"--workflow-id",
		workflowId,
	];
}
