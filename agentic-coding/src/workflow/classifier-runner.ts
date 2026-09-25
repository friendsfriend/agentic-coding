// Runtime half of the pluggable classifier integrations plus the pool-routing
// protocol (classifier-driven-model-pools): collect the bounded OpenSpec
// artifacts, turn them into one System One request carrying every step
// question in parallel, invoke the configured classifier model, and return the
// full answer per question. The effect handler in `effect-runner.ts` owns
// outbox/lease concerns; this module stays a plain bounded I/O helper so it can
// be unit-tested without a workflow.
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
	type ClassifierAnswer,
	type ClassifierInput,
	parseClassifierAnswer,
	ROUTING_CLASSIFIER_MODEL,
	ROUTING_CLASSIFIER_PROFILE,
	ROUTING_ENDPOINT,
	type RoutingQuestionSpec,
	routingQuestionInstructions,
} from "./classifiers.ts";
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
				readonly criteria: Readonly<Record<string, unknown>>;
			}
		>;
	};
}

function bareModel(integrationId: string, model: string): string {
	const prefix = "opencode/";
	if (!model.startsWith(prefix) || model.length === prefix.length)
		throw new PermanentFailure(
			`classifier ${integrationId} requires an opencode/ model, got ${model}`,
		);
	return model.slice(prefix.length);
}

/** Build one routing request holding every classifiable step's question in
 * parallel. One request per pass, never one per step. */
export function routingRequest(
	specs: readonly RoutingQuestionSpec[],
	model: string,
	state: string,
): ClassifierRequest {
	const questions: ClassifierRequest["body"]["questions"] = {};
	for (const spec of specs) {
		const criteria: Record<string, unknown> = {};
		for (const entry of spec.entries)
			criteria[entry.label] =
				entry.criteria !== undefined ? entry.criteria : entry.label;
		questions[spec.stepId] = {
			type: "choice",
			instructions: routingQuestionInstructions(spec.stepId, spec.mode),
			criteria,
		};
	}
	return {
		url: ROUTING_ENDPOINT,
		body: { model: bareModel("routing", model), state, questions },
	};
}

const CLASSIFIER_TIMEOUT_MS = 300_000;

function parseAnswers(
	integrationId: string,
	body: string,
	questionIds: readonly string[],
): Record<string, ClassifierAnswer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new PermanentFailure(
			`classifier ${integrationId} returned invalid JSON`,
		);
	}
	if (!parsed || typeof parsed !== "object")
		throw new PermanentFailure(
			`classifier ${integrationId} returned invalid System One data`,
		);
	const answers = (parsed as { answers?: unknown }).answers;
	const map =
		answers && typeof answers === "object" && !Array.isArray(answers)
			? (answers as Record<string, unknown>)
			: {};
	return Object.fromEntries(
		questionIds.map((id) => [id, parseClassifierAnswer(map[id])]),
	);
}

function requestClassifier(
	integrationId: string,
	request: ClassifierRequest,
	signal?: AbortSignal,
): Effect.Effect<Record<string, ClassifierAnswer>, Error> {
	const apiKey = configEnvValue("OPENCODE_API_KEY")?.trim();
	if (!apiKey)
		return Effect.fail(
			new PermanentFailure(
				`classifier ${integrationId} requires OPENCODE_API_KEY`,
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
						`classifier ${integrationId} request failed: ${error.message}`,
					),
			),
		);
		if (response.status < 200 || response.status >= 300) {
			const message = `classifier ${integrationId} provider returned ${response.status}`;
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
			try: () =>
				parseAnswers(
					integrationId,
					response.body,
					Object.keys(request.body.questions),
				),
			catch: (error) =>
				error instanceof PermanentFailure
					? error
					: new PermanentFailure(
							`classifier ${integrationId} response parsing failed: ${error instanceof Error ? error.message : String(error)}`,
						),
		});
	});
}

function classifierModel(agents: AgentsConfig): string {
	const profile = agents.profiles[ROUTING_CLASSIFIER_PROFILE];
	return profile?.model ?? ROUTING_CLASSIFIER_MODEL;
}

/** Invoke the pool-routing classifier through OpenCode Zen's System One
 * endpoint. The state is the task before planning and the plan artifacts after
 * approval; every spec question travels in one request. */
export function invokeRoutingClassifier(
	specs: readonly RoutingQuestionSpec[],
	agents: AgentsConfig,
	input: {
		task: string;
		changeId: string;
		artifacts: ClassifierInput["artifacts"];
	},
	signal?: AbortSignal,
): Effect.Effect<Record<string, ClassifierAnswer>, Error> {
	const model = classifierModel(agents);
	const instruction = specs.some((spec) => spec.mode === "roster")
		? ROUTING_ROSTER_INSTRUCTION
		: ROUTING_SINGLE_INSTRUCTION;
	const state = renderRoutingState(instruction, input);
	const request = routingRequest(specs, model, state);
	return requestClassifier("routing", request, signal);
}

const ROUTING_SINGLE_INSTRUCTION = `You assign model profiles to OpenSpec workflow steps.
Each question names one workflow step and a list of labelled candidate
profiles with their criteria. Answer with the label of the single best fit.`;
const ROUTING_ROSTER_INSTRUCTION = `You assign model profiles to OpenSpec workflow steps.
One question is a planning roster: choose the subset of labelled planner
profiles that should plan in parallel. Answer with the labels of the best two
to five distinct profiles.`;

function renderRoutingState(
	instruction: string,
	input: {
		task: string;
		changeId: string;
		artifacts: ClassifierInput["artifacts"];
	},
): string {
	const header = [
		instruction.trim(),
		"",
		`Change: ${input.changeId || "(unknown)"}`,
		input.task.trim() ? `Task: ${input.task.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const body = input.artifacts
		.map(
			(artifact) =>
				`<artifact path="${artifact.path}">\n${artifact.content}\n</artifact>`,
		)
		.join("\n\n");
	return `${header}\n\n${body}\n`;
}
