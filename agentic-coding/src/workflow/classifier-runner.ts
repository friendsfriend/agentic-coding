// Runtime half of the pluggable classifier integrations
// (introduce-jev-for-model-range-decision): collect the bounded OpenSpec
// artifacts, turn them into a System One request, invoke the configured
// classifier model, and return its selected answer. The effect handler
// in `effect-runner.ts` owns outbox/lease concerns; this module stays a plain
// bounded I/O helper so it can be unit-tested without a workflow.
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { ClassifierInput, ClassifierIntegration } from "./classifiers.ts";
import { renderClassifierPrompt } from "./classifiers.ts";
import { configEnvValue, postJsonEffect } from "./effects.ts";
import { PermanentFailure, TransientFailure } from "./failures.ts";
import type { AgentsConfig } from "./profiles.ts";

/** Per-artifact and total caps so a large change cannot blow up the prompt or
 * the request body budget. */
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

export interface ClassifierRequest {
	readonly url: string;
	readonly body: {
		readonly model: string;
		readonly state: string;
		readonly questions: Record<
			string,
			{
				readonly type: "choice";
				readonly instructions: string;
				readonly criteria: Readonly<Record<string, string>>;
			}
		>;
	};
}

/** Build the typed OpenCode Zen System One request. JEV model IDs are bare at
 * this endpoint; config keeps the provider/model spelling for clarity. */
export function classifierRequest(
	integration: ClassifierIntegration,
	model: string,
	state: string,
): ClassifierRequest {
	const prefix = "opencode/";
	if (!model.startsWith(prefix) || model.length === prefix.length)
		throw new PermanentFailure(
			`classifier ${integration.id} requires an opencode/ model, got ${model}`,
		);
	const question = integration.question;
	return {
		url: integration.endpoint,
		body: {
			model: model.slice(prefix.length),
			state,
			questions: {
				[question.id]: {
					type: "choice",
					instructions: question.instructions,
					criteria: question.criteria,
				},
			},
		},
	};
}

const CLASSIFIER_TIMEOUT_MS = 300_000;

function answerChoice(
	integration: ClassifierIntegration,
	body: string,
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new PermanentFailure(
			`classifier ${integration.id} returned invalid JSON`,
		);
	}
	if (!parsed || typeof parsed !== "object")
		throw new PermanentFailure(
			`classifier ${integration.id} returned invalid System One data`,
		);
	const answers = (parsed as { answers?: unknown }).answers;
	const answer =
		answers && typeof answers === "object"
			? (answers as Record<string, unknown>)[integration.question.id]
			: undefined;
	const choice =
		answer && typeof answer === "object"
			? (answer as { choice?: unknown }).choice
			: undefined;
	if (typeof choice !== "string" || !choice.trim())
		throw new PermanentFailure(
			`classifier ${integration.id} returned no choice for ${integration.question.id}`,
		);
	return choice;
}

function requestClassifier(
	integration: ClassifierIntegration,
	request: ClassifierRequest,
	signal?: AbortSignal,
): Effect.Effect<string, Error> {
	const apiKey = configEnvValue("OPENCODE_API_KEY")?.trim();
	if (!apiKey)
		return Effect.fail(
			new PermanentFailure(
				`classifier ${integration.id} requires OPENCODE_API_KEY`,
			),
		);
	return Effect.gen(function* () {
		const response = yield* postJsonEffect(
			request.url,
			request.body,
			{
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			{ signal, timeoutMs: CLASSIFIER_TIMEOUT_MS },
		).pipe(
			Effect.mapError(
				(error) =>
					new TransientFailure(
						`classifier ${integration.id} request failed: ${error.message}`,
					),
			),
		);
		if (response.status < 200 || response.status >= 300) {
			const message = `classifier ${integration.id} provider returned ${response.status}`;
			if (
				response.status === 408 ||
				response.status === 425 ||
				response.status === 429 ||
				response.status >= 500
			)
				return yield* Effect.fail(new TransientFailure(message));
			return yield* Effect.fail(new PermanentFailure(message));
		}
		return yield* Effect.try({
			try: () => answerChoice(integration, response.body),
			catch: (error) =>
				error instanceof PermanentFailure
					? error
					: new PermanentFailure(
							`classifier ${integration.id} response parsing failed: ${error instanceof Error ? error.message : String(error)}`,
						),
		});
	});
}

/** Invoke one classifier through OpenCode Zen's System One endpoint and return
 * its selected choice. Provider failures are typed for durable retry handling. */
export function invokeClassifier(
	integration: ClassifierIntegration,
	agents: AgentsConfig,
	input: {
		task: string;
		changeId: string;
		artifacts: ClassifierInput["artifacts"];
	},
	signal?: AbortSignal,
): Effect.Effect<string, Error> {
	const profile = Object.hasOwn(agents.profiles, integration.profile)
		? agents.profiles[integration.profile]
		: undefined;
	const model = profile?.model ?? integration.model;
	const prompt = renderClassifierPrompt(integration, input);
	const request = classifierRequest(integration, model, prompt);
	return requestClassifier(integration, request, signal);
}
