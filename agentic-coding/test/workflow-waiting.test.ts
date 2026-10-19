// The developer wait projection (record-repairs-and-developer-waits, item 12).
// Pure: the state that blocks a workflow in, the wait it means out.
import { expect, test } from "bun:test";
import {
	type DeveloperQuestionStatus,
	sameWorkflowWait,
	type WorkflowWait,
	waitSeconds,
} from "../src/contracts/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	definitionStepActor,
	workflowWait,
} from "../src/workflow/runtime/waiting.ts";

function question(overrides: {
	id?: string;
	status?: DeveloperQuestionStatus;
	expiresAt?: string;
	createdAt?: string;
	targetRole?: string;
}) {
	return {
		id: overrides.id ?? "question-1",
		workflowId: "wf",
		runId: "run-1",
		stepId: "core.implementation",
		role: "worker",
		description: "which design?",
		options: [],
		status: overrides.status ?? "pending",
		createdAt: overrides.createdAt ?? "2026-01-02T11:50:00.000Z",
		expiresAt: overrides.expiresAt ?? "2026-01-03T11:50:00.000Z",
		...(overrides.targetRole ? { targetRole: overrides.targetRole } : {}),
	};
}

function state(overrides: {
	status?: "active" | "paused" | "attention-required" | "completed" | "closed";
	step?: string;
	stepEnteredAt?: string;
	stepActor?: "agent" | "developer" | "system";
	questions?: ReturnType<typeof question>[];
	runs?: Array<{
		id: string;
		status: "working" | "blocked" | "completed";
		completedAt?: string;
	}>;
}) {
	return {
		status: overrides.status ?? ("active" as const),
		currentStep: overrides.step ?? "core.implementation",
		stepEnteredAt: overrides.stepEnteredAt ?? "2026-01-02T11:00:00.000Z",
		stepActor: overrides.stepActor ?? ("agent" as const),
		questions: overrides.questions ?? [],
		runs: overrides.runs ?? [],
	};
}

test("a pending developer question is the wait, named by the question", () => {
	const wait = workflowWait(state({ questions: [question({})] }));
	expect(wait).toEqual({
		kind: "question",
		subject: "question-1",
		since: "2026-01-02T11:50:00.000Z",
	});
});

test("a question routed to a peer agent is not the developer's wait", () => {
	// The detector is generic over the record, so any future question kind is
	// covered; what excludes a record is the routing marker, not its kind.
	expect(
		workflowWait(state({ questions: [question({ targetRole: "verifier" })] })),
	).toBeUndefined();
	// Still routed to the orchestrator: the developer is the backstop, so the wait
	// is on them from the moment the question exists.
	expect(
		workflowWait(
			state({ questions: [question({ targetRole: "orchestrator" })] }),
		)?.kind,
	).toBe("question");
});

test("an answered or expired question is no wait", () => {
	expect(
		workflowWait(state({ questions: [question({ status: "answered" })] })),
	).toBeUndefined();
	expect(
		workflowWait(state({ questions: [question({ status: "expired" })] })),
	).toBeUndefined();
	// Still pending in the store but past its durable expiry: the wait is open
	// until the expiry the engine records ends it, so no pair is left dangling by
	// the clock alone.
	expect(
		workflowWait(
			state({ questions: [question({ expiresAt: "2026-01-02T11:59:59Z" })] }),
		)?.kind,
	).toBe("question");
});

test("the oldest open question is the subject, and a question wins over a handoff", () => {
	const wait = workflowWait(
		state({
			stepActor: "developer",
			questions: [
				question({ id: "newer", createdAt: "2026-01-02T11:55:00.000Z" }),
				question({ id: "older", createdAt: "2026-01-02T11:10:00.000Z" }),
			],
			runs: [{ id: "run-blocked", status: "blocked" }],
		}),
	);
	// Oldest first: the developer has been waiting on that one longest, whatever
	// order the records arrive in.
	expect(wait?.subject).toBe("older");
});

test("a blocked run is a handoff wait, named by the run and timed from its completion", () => {
	const wait = workflowWait(
		state({
			stepActor: "developer",
			runs: [
				{ id: "run-working", status: "working" },
				{
					id: "run-blocked",
					status: "blocked",
					completedAt: "2026-01-02T11:30:00.000Z",
				},
			],
		}),
	);
	expect(wait).toEqual({
		kind: "handoff",
		subject: "run-blocked",
		since: "2026-01-02T11:30:00.000Z",
	});
});

test("a developer-actor step is an approval wait, timed from the step entry", () => {
	const wait = workflowWait(
		state({
			step: "core.plan-approval",
			stepActor: "developer",
			stepEnteredAt: "2026-01-02T11:40:00.000Z",
		}),
	);
	expect(wait).toEqual({
		kind: "approval",
		subject: "core.plan-approval",
		since: "2026-01-02T11:40:00.000Z",
	});
});

test("an agent step waiting for nothing is no wait", () => {
	expect(workflowWait(state({}))).toBeUndefined();
});

test("a completed or closed workflow waits for nobody", () => {
	const waiting = state({
		status: "attention-required",
		stepActor: "developer",
		questions: [question({})],
	});
	expect(workflowWait(waiting)?.kind).toBe("question");
	// A run that ended in `attention-required` still owes the developer an answer:
	// only completion and closing end an open wait at the close.
	for (const status of ["completed", "closed"] as const)
		expect(workflowWait({ ...waiting, status })).toBeUndefined();
});

test("two waits describe the same obligation when kind and subject match", () => {
	const wait: WorkflowWait = {
		kind: "question",
		subject: "q",
		since: "2026-01-02T11:00:00.000Z",
	};
	expect(
		sameWorkflowWait(wait, { ...wait, since: "2026-01-02T11:30:00.000Z" }),
	).toBe(true);
	expect(sameWorkflowWait(wait, { ...wait, kind: "approval" })).toBe(false);
	expect(sameWorkflowWait(undefined, undefined)).toBe(true);
	expect(sameWorkflowWait(wait, undefined)).toBe(false);
});

test("wait seconds are whole, never negative and absent without a start", () => {
	expect(
		waitSeconds("2026-01-02T11:58:00.000Z", "2026-01-02T12:00:00.000Z"),
	).toBe(120);
	expect(
		waitSeconds("2026-01-02T12:01:00.000Z", "2026-01-02T12:00:00.000Z"),
	).toBe(0);
	expect(waitSeconds(undefined, "2026-01-02T12:00:00.000Z")).toBeUndefined();
	expect(waitSeconds("not-a-time", "2026-01-02T12:00:00.000Z")).toBeUndefined();
});

test("an unresolved step is no approval wait instead of a throw", () => {
	const registry = registerBuiltins();
	const definition = registry.definition("no-openspec", 1);
	expect(definitionStepActor(registry, definition, "core.implementation")).toBe(
		"agent",
	);
	expect(
		definitionStepActor(registry, definition, "core.not-a-step"),
	).toBeUndefined();
});
