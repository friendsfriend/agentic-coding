// Runtime half of the pluggable classifier integrations
// (introduce-jev-for-model-range-decision): collect the bounded OpenSpec
// artifacts, turn them into a prompt through the integration, invoke the
// configured classifier model, and return its raw answer. The effect handler
// in `effect-runner.ts` owns outbox/lease concerns; this module stays a plain
// bounded I/O helper so it can be unit-tested without a workflow.
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { ClassifierInput, ClassifierIntegration } from "./classifiers.ts";
import { renderClassifierPrompt } from "./classifiers.ts";
import { PermanentFailure, TransientFailure } from "./failures.ts";
import { runProcessEffect } from "./process.ts";
import type { AgentsConfig } from "./profiles.ts";

/** Per-artifact and total caps so a large change cannot blow up the prompt or
 * the process argv budget. */
export const CLASSIFIER_ARTIFACT_CAP_BYTES = 96 * 1024;
export const CLASSIFIER_TOTAL_CAP_BYTES = 256 * 1024;

/** Read the change's planning artifacts in a stable order. Missing files are
 * skipped; an unknown change id yields no artifacts (the classifier then sees
 * only the task and allowed categories). */
export function collectClassifierArtifacts(
	worktree: string,
	changeId: string,
): ClassifierInput["artifacts"] {
	const artifacts: Array<{ path: string; content: string }> = [];
	if (!changeId) return artifacts;
	const root = path.join(worktree, "openspec", "changes", changeId);
	if (!fs.existsSync(root)) return artifacts;
	const relative: string[] = [];
	for (const file of ["proposal.md", "design.md", "tasks.md"]) {
		if (fs.existsSync(path.join(root, file))) relative.push(file);
	}
	const specs = path.join(root, "specs");
	if (fs.existsSync(specs))
		for (const entry of fs.readdirSync(specs, { withFileTypes: true }).sort())
			if (
				entry.isDirectory() &&
				fs.existsSync(path.join(specs, entry.name, "spec.md"))
			)
				relative.push(path.join("specs", entry.name, "spec.md"));
	let total = 0;
	for (const file of relative) {
		if (total >= CLASSIFIER_TOTAL_CAP_BYTES) break;
		try {
			const content = fs
				.readFileSync(path.join(root, file), "utf8")
				.slice(0, CLASSIFIER_ARTIFACT_CAP_BYTES);
			total += Buffer.byteLength(content);
			artifacts.push({ path: file, content });
		} catch {
			/* unreadable artifact is skipped, never fatal */
		}
	}
	return artifacts;
}

export interface ClassifierCommand {
	readonly args: string[];
	readonly cwd: string;
}

/** Build the one-shot model command. Only `pi` is wired today; the
 * classifier integration's own runtime/model are used unless the configured
 * profile overrides them. */
export function classifierCommand(
	integration: ClassifierIntegration,
	agents: AgentsConfig,
	prompt: string,
	cwd: string,
): ClassifierCommand {
	const profile = Object.hasOwn(agents.profiles, integration.profile)
		? agents.profiles[integration.profile]
		: undefined;
	const runtime = profile?.runtime ?? integration.runtime;
	const model = profile?.model ?? integration.model;
	const executable =
		profile?.executable ?? (runtime === "opencode-v2" ? "opencode2" : runtime);
	if (runtime !== "pi")
		throw new PermanentFailure(
			`classifier runtime ${runtime} is not supported yet for ${integration.id}`,
		);
	const args = [
		executable,
		"--print",
		"--mode",
		"text",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-tools",
		"--model",
		model,
	];
	if (profile?.thinking) args.push("--thinking", profile.thinking);
	args.push(prompt);
	return { args, cwd };
}

/** Invoke one classifier and return its raw answer text. Transient process
 * failures request the durable retry budget; a missing executable or an
 * unusable invocation is permanent. */
export function invokeClassifier(
	integration: ClassifierIntegration,
	agents: AgentsConfig,
	worktree: string,
	input: {
		task: string;
		changeId: string;
		artifacts: ClassifierInput["artifacts"];
	},
	signal?: AbortSignal,
): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const prompt = renderClassifierPrompt(integration, input);
		const command = classifierCommand(integration, agents, prompt, worktree);
		const result = yield* runProcessEffect(command.args, {
			cwd: command.cwd,
			signal,
			timeoutMs: 300_000,
		}).pipe(
			Effect.mapError((failure) =>
				failure._tag === "exit"
					? new PermanentFailure(
							`classifier ${integration.id} exited ${failure.exitCode}: ${failure.detail}`,
						)
					: new TransientFailure(
							`classifier ${integration.id} failed: ${failure.detail}`,
						),
			),
		);
		return result.stdout.trim();
	});
}
