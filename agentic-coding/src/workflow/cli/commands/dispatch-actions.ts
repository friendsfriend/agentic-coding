// The developer-action, agent-handoff, and agent-question command branches:
// `action`, `question`, and `handoff`. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import { QUESTION_WAIT_MS, type WorkflowEngine } from "../../runtime.ts";
import {
	flag,
	parseInlineJson,
	parseInput,
	positionals,
	requireFlag,
} from "../args.ts";
import { managedAgent, managedWorkflowTarget } from "../caller-environment.ts";
import { detachedDrainArgv, drainEffects } from "../drain.ts";
import { resolveHandoffIdentity } from "../identity.ts";

export function validateQuestionTimeout(timeoutMs: number): void {
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > QUESTION_WAIT_MS
	)
		throw new Error(
			`question timeout must be an integer from 1 to ${QUESTION_WAIT_MS}`,
		);
}

type DeveloperQuestionCliInput = {
	description?: string;
	context?: string;
	options?: unknown;
	questions?: unknown;
};
export async function runDeveloperQuestion(
	engineInstance: WorkflowEngine,
	repo: string,
	inputOrDescription: DeveloperQuestionCliInput | string,
	optionsOrTimeout: unknown = [],
	timeoutMs = QUESTION_WAIT_MS,
): Promise<string> {
	const input: DeveloperQuestionCliInput =
		typeof inputOrDescription === "string"
			? { description: inputOrDescription, options: optionsOrTimeout }
			: inputOrDescription;
	const wait =
		typeof optionsOrTimeout === "number" ? optionsOrTimeout : timeoutMs;
	if (input.description !== undefined && !input.description.trim())
		throw new Error("question requires a non-empty description");
	if (input.description === undefined && input.questions === undefined)
		throw new Error("question requires --description or --questions");
	validateQuestionTimeout(wait);
	const identity = resolveHandoffIdentity(engineInstance, repo);
	const run = engineInstance.authorizeExactRunCapability(
		repo,
		identity.workflowId,
		identity.runId,
		identity.stepId,
		identity.role,
		identity.token,
	);
	const created = engineInstance.dispatch(repo, {
		type: "agent.question",
		workflowId: run.workflowId,
		runId: run.id,
		stepId: run.stepId,
		role: run.role,
		token: identity.token,
		...(input.description === undefined
			? {}
			: { description: input.description }),
		...(input.context === undefined ? {} : { context: input.context }),
		...(input.options === undefined ? {} : { options: input.options }),
		...(input.questions === undefined ? {} : { questions: input.questions }),
	});
	const newest = created.snapshot.developerDialogue.at(-1);
	if (!newest) throw new Error("question was not recorded");
	const groupId = newest.groupId;
	const questionIds = groupId
		? created.snapshot.developerDialogue
				.filter((item) => item.groupId === groupId)
				.map((item) => item.id)
		: [newest.id];
	const deadline = Date.now() + wait;
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	process.on("SIGTERM", interrupt);
	process.on("SIGINT", interrupt);
	try {
		while (!interrupted && Date.now() < deadline) {
			const dialogue = engineInstance.getSnapshot(
				repo,
				run.workflowId,
			).developerDialogue;
			const questions = questionIds.map((id) =>
				dialogue.find((item) => item.id === id),
			);
			if (questions.some((question) => !question))
				throw new Error("question disappeared from workflow state");
			if (
				questions.every((question) => question && question.status !== "pending")
			)
				return groupId
					? JSON.stringify({
							groupId,
							status: questions.some(
								(question) => question?.status === "expired",
							)
								? "expired"
								: questions.some((question) => question?.status === "cancelled")
									? "cancelled"
									: "answered",
							responses: questions.map((question) => ({
								questionId: question?.id,
								itemIndex: question?.itemIndex,
								answer: question?.answer,
							})),
						})
					: JSON.stringify(questions[0]);
			await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
		}
		try {
			engineInstance.dispatch(repo, {
				type: "agent.question-expire",
				workflowId: run.workflowId,
				questionId: questionIds[0] ?? "",
				runId: run.id,
				stepId: run.stepId,
				role: run.role,
				token: identity.token,
			});
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/no longer pending|expired/.test(error.message)
			)
				throw error;
		}
		const dialogue = engineInstance.getSnapshot(
			repo,
			run.workflowId,
		).developerDialogue;
		const expired = questionIds.map((id) =>
			dialogue.find((item) => item.id === id),
		);
		if (!groupId)
			return JSON.stringify(
				expired[0] ?? { status: "expired", id: questionIds[0] },
			);
		const status = expired.some((question) => question?.status === "expired")
			? "expired"
			: expired.some((question) => question?.status === "cancelled")
				? "cancelled"
				: "answered";
		return JSON.stringify({
			groupId,
			status,
			responses: expired.map((question) => ({
				questionId: question?.id,
				itemIndex: question?.itemIndex,
				answer: question?.answer,
			})),
		});
	} finally {
		process.off("SIGTERM", interrupt);
		process.off("SIGINT", interrupt);
	}
}

export async function runAction(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
): Promise<void> {
	if (managedAgent())
		throw new Error(
			"developer actions require the interactive developer channel",
		);
	const actions = positionals(rest);
	if (actions.length !== 1 || !actions[0]?.trim())
		throw new Error(
			actions.length > 1
				? "action: unexpected positional argument"
				: "action: ACTION_ID is required",
		);
	const view = workflowEngine.status(repo, requireFlag(rest, "workflow-id"));
	workflowEngine.dispatch(repo, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision: Number(flag(rest, "revision")),
		actionId: actions[0],
		input: parseInput(flag(rest, "input")),
	});
	await drainEffects(workflowEngine, repo);
	console.log(
		JSON.stringify(
			workflowEngine.status(repo, requireFlag(rest, "workflow-id")),
			null,
			2,
		),
	);
}

export async function runQuestion(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	if (!managedAgent())
		throw new Error("question requires an authenticated managed agent");
	const description = flag(rest, "description");
	const questions = flag(rest, "questions");
	if (description === undefined && questions === undefined)
		throw new Error("question requires --description or --questions");
	if (description !== undefined && questions !== undefined)
		throw new Error("question accepts either --description or --questions");
	const input = {
		...(description === undefined ? {} : { description }),
		...(flag(rest, "context") === undefined
			? {}
			: { context: flag(rest, "context") }),
		...(flag(rest, "options") === undefined
			? {}
			: { options: parseInput(flag(rest, "options")) }),
		...(questions === undefined
			? {}
			: { questions: parseInlineJson(questions, "--questions") }),
	};
	const timeout = flag(rest, "timeout");
	const timeoutMs = timeout === undefined ? QUESTION_WAIT_MS : Number(timeout);
	console.log(
		await runDeveloperQuestion(
			workflowEngine,
			managedWorkflowTarget(),
			input,
			timeoutMs,
		),
	);
}

export async function runHandoff(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	const outcome = flag(rest, "outcome");
	if (
		outcome === undefined ||
		!["complete", "blocked", "failed"].includes(outcome)
	)
		throw new Error("handoff: invalid --outcome");
	const target = managedWorkflowTarget();
	const identity = resolveHandoffIdentity(workflowEngine, target);
	const artifact = identity.outputPath ?? flag(rest, "artifact");
	const result = workflowEngine.dispatch(target, {
		type: "agent.handoff",
		runId: identity.runId,
		generation: identity.generation,
		token: identity.token,
		outcome,
		...(artifact ? { artifact } : {}),
		...(flag(rest, "message") ? { message: flag(rest, "message") } : {}),
	});
	if (!rest.includes("--no-drain")) await drainEffects(workflowEngine, target);
	else {
		const entry = Bun.main.startsWith("$bunfs") ? undefined : Bun.main;
		const drain = Bun.spawn(
			detachedDrainArgv(entry, target, result.view.workflowId),
			{
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
				cwd: process.cwd(),
				env: process.env,
			},
		);
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && drain.exitCode === null) Bun.sleepSync(50);
		if (drain.exitCode !== null && drain.exitCode !== 0)
			console.error(
				`detached drain exited early (${drain.exitCode}); run status to drain pending effects`,
			);
		drain.unref();
	}
	console.log(
		JSON.stringify(
			workflowEngine.status(target, result.view.workflowId),
			null,
			2,
		),
	);
}
