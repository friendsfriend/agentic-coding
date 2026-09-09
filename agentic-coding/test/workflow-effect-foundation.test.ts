import { expect, test } from "bun:test";
import {
	decodeCommand,
	decodeDeveloperQuestionAnswer,
	decodeSnapshot,
	externalDiagnostic,
	isRetryableFailure,
	type WorkflowFailure,
} from "../src/workflow/contracts.ts";

test("tagged failures expose stale-revision and validation distinctions", () => {
	const stale: WorkflowFailure = {
		_tag: "stale-revision",
		code: "stale-run",
		message: "run issued against an older revision",
		currentRevision: 7,
	};
	expect(stale.code).toBe("stale-run");
	expect(stale.currentRevision).toBe(7);
	expect(externalDiagnostic(stale)).toEqual({
		code: "stale-run",
		message: "run issued against an older revision",
	});

	const staleOwnership: WorkflowFailure = {
		_tag: "stale-ownership",
		code: "stale-effect",
		message: "effect lease expired",
	};
	expect(externalDiagnostic(staleOwnership).code).toBe("stale-effect");

	const validation: WorkflowFailure = {
		_tag: "validation",
		code: "invalid-input",
		message: "expected non-empty string",
	};
	expect(validation._tag).toBe("validation");
	expect(isRetryableFailure(validation)).toBe(false);
});

test("unexpected defects stay distinct from retryable infrastructure failures", () => {
	const defect: WorkflowFailure = { _tag: "defect", message: "bug" };
	const infra: WorkflowFailure = {
		_tag: "infrastructure",
		code: "unavailable",
		message: "store temporarily unavailable",
	};
	expect(isRetryableFailure(defect)).toBe(false);
	expect(isRetryableFailure(infra)).toBe(true);
	// A defect must not be silently retried through the external code path.
	expect(externalDiagnostic(defect).code).toBe("unavailable");
	expect(externalDiagnostic(defect).message).toBe("bug");
});

test("external diagnostics are bounded and redacted of raw secrets", () => {
	const longSecret = `token=${"s".repeat(9000)}`;
	const failure: WorkflowFailure = {
		_tag: "unauthorized",
		code: "unauthorized",
		message: `rejected credential ${longSecret}`,
	};
	const diagnostic = externalDiagnostic(failure);
	expect(diagnostic.message.length).toBeLessThanOrEqual(2048);
	expect(diagnostic.message).not.toContain("s".repeat(9000));

	// Bare credential labels without a secret keyword prefix must also be
	// masked (defense in depth; SEC-001 advisory).
	const bare = externalDiagnostic({
		_tag: "unauthorized",
		code: "unauthorized",
		message: "rejected key=BARE-SK-99 nonce=N-1 hash=H-2",
	});
	expect(bare.message).not.toContain("BARE-SK-99");
	expect(bare.message).not.toContain("N-1");
	expect(bare.message).not.toContain("H-2");
	expect(bare.message).toContain("<redacted>");
});

test("decodeContract strips raw received values so short secrets never leak", () => {
	// SEC-002: build a real ContractFailure from a malformed capability-bearing
	// envelope carrying a short secret in a wrong-typed field, convert it into a
	// WorkflowFailure, and assert the secret is absent end to end. A short
	// token inside the first 2048 bytes must not survive into the diagnostic.
	const secret = "S3CRET-SHORT-1";
	let contractFailure: unknown;
	try {
		decodeCommand({
			type: "agent.handoff",
			runId: "r",
			generation: 1,
			token: { leaked: secret },
			outcome: "complete",
		});
	} catch (error) {
		contractFailure = error;
	}
	expect(contractFailure).toBeInstanceOf(Error);
	const message = (contractFailure as Error).message;
	expect(message).not.toContain(secret);
	expect(message).toContain("$.token");

	const failure: WorkflowFailure = {
		_tag: "validation",
		code: "invalid-input",
		message,
	};
	expect(externalDiagnostic(failure).message).not.toContain(secret);
	expect(externalDiagnostic(failure).message.length).toBeLessThanOrEqual(2048);

	// A wrong-typed custom answer value must not embed the raw object either.
	try {
		decodeDeveloperQuestionAnswer({
			questionId: "q",
			kind: "custom",
			value: { buried: secret },
		});
	} catch (error) {
		expect((error as Error).message).not.toContain(secret);
	}
});

test("decode errors are field-localized with bounded messages", () => {
	// QUALITY-002: per-issue path/message instead of a full union/schema dump.
	expect(() =>
		decodeCommand({
			type: "agent.question",
			workflowId: "w",
			runId: "r",
			stepId: "s",
			role: "worker",
			token: "t",
			description: "x",
			questions: [{ description: "ok", options: [1, 2] }],
		}),
	).toThrow(/\$\.questions\[0\]\.options\[0\]/);
});

test("text bounds count UTF-8 bytes like the legacy parsers", () => {
	// QUALITY-001 / SEC-003: 64 astral chars are 128 UTF-16 units but 256 bytes;
	// a text(128) bound must reject them.
	const astral = "\u{1F600}".repeat(64);
	expect(astral.length).toBe(128);
	expect(Buffer.byteLength(astral, "utf8")).toBe(256);
	expect(() =>
		decodeCommand({
			type: "timer.question-expire",
			workflowId: "w",
			questionId: "q",
			timerNonce: astral,
		}),
	).toThrow(/expected non-empty string <= 128 bytes/);
	// Exactly 128 UTF-8 bytes stays accepted.
	const ascii = "a".repeat(128);
	expect(() =>
		decodeCommand({
			type: "timer.question-expire",
			workflowId: "w",
			questionId: "q",
			timerNonce: ascii,
		}),
	).not.toThrow();
});

test("snapshot round-trip preserves schema-declared and unknown keys", () => {
	// QUALITY-004: unknown/forward-compat top-level and nested keys must survive
	// the decode-rewrite cycle instead of being silently dropped.
	const snapshot = decodeSnapshot({
		schemaVersion: 1,
		workflowId: "w",
		revision: 0,
		definition: { id: "no-openspec", version: 1, digest: "d" },
		status: "active",
		currentStep: "core.implementation",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: ".",
			worktree: ".",
			branch: "main",
			baseBranch: "main",
			baseCommit: "x",
			createdAt: "x",
			updatedAt: "x",
			stepEnteredAt: "x",
			legacyMeta: { keep: true },
		},
		routing: { defaultProfile: "x", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		forwardCompatField: { keep: true },
	});
	expect(
		(snapshot as unknown as Record<string, unknown>).forwardCompatField,
	).toEqual({ keep: true });
	expect(
		(snapshot.metadata as unknown as Record<string, unknown>).legacyMeta,
	).toEqual({ keep: true });
});

test("requireText failures name the snapshot contract, not a field path", () => {
	// QUALITY-003: an empty repository-relative path must surface as a
	// core.workflow-snapshot contract failure.
	expect(() =>
		decodeSnapshot({
			schemaVersion: 1,
			workflowId: "w",
			revision: 0,
			definition: { id: "no-openspec", version: 1, digest: "d" },
			status: "active",
			currentStep: "core.implementation",
			step: {
				attempt: 1,
				activeRunIds: [],
				completedRunIds: [],
				selectedRoles: [],
				testRunStarted: false,
				results: [],
			},
			metadata: {
				repository: "",
				worktree: ".",
				branch: "main",
				baseBranch: "main",
				baseCommit: "x",
				createdAt: "x",
				updatedAt: "x",
				stepEnteredAt: "x",
			},
			routing: { defaultProfile: "x", routes: [] },
			evidence: [],
			loopCounts: {},
			attention: [],
		}),
	).toThrow(/core\.workflow-snapshot/);
});

test("schema-backed command and answer facades preserve acceptance behavior", () => {
	const command = decodeCommand({
		type: "operator.repair",
		workflowId: "w",
		revision: 3,
		targetStep: "core.implementation",
	});
	expect(command.type).toBe("operator.repair");
	if (command.type !== "operator.repair") throw new Error("unreachable");
	expect(command.reason).toBe("");
	expect(() =>
		decodeCommand({
			type: "agent.question",
			workflowId: "w",
			runId: "r",
			stepId: "s",
			role: "worker",
			token: "t",
			description: "x",
			questions: [{ description: "y" }],
		}),
	).toThrow(/either description or questions/);
	expect(
		decodeDeveloperQuestionAnswer({
			questionId: "q",
			kind: "custom",
			value: "line 1\nline 2",
		}),
	).toEqual({ questionId: "q", kind: "custom", value: "line 1\nline 2" });
});

test("schema-backed snapshot decoding normalizes paths and keeps legacy default dialogue", () => {
	const snapshot = decodeSnapshot({
		schemaVersion: 1,
		workflowId: "w",
		revision: 0,
		definition: { id: "no-openspec", version: 1, digest: "d" },
		status: "active",
		currentStep: "core.implementation",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: ".",
			worktree: ".",
			branch: "main",
			baseBranch: "main",
			baseCommit: "x",
			createdAt: "x",
			updatedAt: "x",
			stepEnteredAt: "x",
		},
		routing: { defaultProfile: "x", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
	});
	expect(snapshot.developerDialogue).toEqual([]);
	expect(snapshot.metadata.worktree).toBe(process.cwd());
	expect(() =>
		decodeSnapshot({
			schemaVersion: 2,
			workflowId: "w",
			revision: 0,
			definition: { id: "no-openspec", version: 1, digest: "d" },
			status: "active",
			currentStep: "core.implementation",
			step: {
				attempt: 1,
				activeRunIds: [],
				completedRunIds: [],
				selectedRoles: [],
				testRunStarted: false,
				results: [],
			},
			metadata: {
				repository: ".",
				worktree: ".",
				branch: "main",
				baseBranch: "main",
				baseCommit: "x",
				createdAt: "x",
				updatedAt: "x",
				stepEnteredAt: "x",
			},
			routing: { defaultProfile: "x", routes: [] },
			evidence: [],
			loopCounts: {},
			attention: [],
		}),
	).toThrow();
});
