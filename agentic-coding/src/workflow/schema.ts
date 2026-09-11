// Effect Schema-backed contract decoding for the workflow package
// (adopt-workflow-effect-foundation, phase 1).
//
// This module is the single source of truth for decoding workflow command,
// developer-dialogue, snapshot/profile/settings, and built-in step
// input/output data. Each contract is expressed as an Effect `Schema`, and the
// synchronous `Contract<T>.parse` facades in `contracts.ts` /
// `definitions/contracts.ts` delegate here — they are not second validators.
//
// Cross-field invariants and byte-size bounds that Effect Schema cannot
// express as a single field schema are kept as pure validation helpers in the
// `schema.ts` `filter*` builders or as small pure functions in the delegating
// facade, exactly as the phase-1 design permits.
//
// Schema implementation metadata never enters durable pins or wire values;
// contract IDs/versions and definition/step digests are independent of the
// parser implementation.
import { Schema } from "effect";
import { ArrayFormatter, ParseError } from "effect/ParseResult";
import type {
	DeveloperQuestionOption,
	ResolvedProfile,
	WorkflowExecutionSettings,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// Synchronous contract error + decode helper (moved here so the Effect-aware
// module can throw the established expected-validation-failure type without
// a runtime import cycle back into contracts.ts).
// ---------------------------------------------------------------------------

export interface ContractError {
	path: string;
	message: string;
}
export class ContractFailure extends Error {
	constructor(
		readonly contractId: string,
		readonly issues: ContractError[],
	) {
		super(
			`${contractId}: ${issues
				.slice(0, 8)
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
}
export interface Contract<T> {
	readonly id: string;
	readonly version: number;
	parse(value: unknown): T;
}

/** Cap for a single parsed issue message so diagnostics stay bounded. */
const MAX_ISSUE_MESSAGE_CHARS = 256;

/** Render an Effect issue path (property + index parts) as a `$.a.b[0]` path. */
function formatIssuePath(path: readonly PropertyKey[]): string {
	let formatted = "$";
	for (const part of path) {
		formatted +=
			typeof part === "number" || /^\d+$/.test(String(part))
				? `[${String(part)}]`
				: `.${String(part)}`;
	}
	return formatted;
}

/** Bound an Effect issue message and strip raw received values. Leaf type
 * errors are formatted `Expected <type>, actual <value>`; `<value>` is the raw
 * input and can be a capability token or secret carried on a wrong-typed
 * field, so it must never reach messages or diagnostics (SEC-001). Refinement
 * messages (custom filter text) have no raw value and pass through unchanged. */
function sanitizeIssueMessage(message: string): string {
	const bounded =
		message.length > MAX_ISSUE_MESSAGE_CHARS
			? `${message.slice(0, MAX_ISSUE_MESSAGE_CHARS)}\u2026`
			: message;
	return bounded
		.replace(/,\s*actual\s.+$/s, "")
		.replace(/Expected /g, "expected ");
}

/** Run a Schema decode and surface expected validation failures as the
 * established `ContractFailure` rather than an Effect `ParseError`, with one
 * localized issue per parsed field instead of a full union/schema dump. The
 * schema parameter is typed loosely because Effect Schema generic inference
 * does not always line up with the domain contract types (readonly arrays,
 * optional vs `| undefined`); the facade casts the decoded value to the
 * contract type. */
export function decodeContract<T>(
	contractId: string,
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types (readonly arrays, optional vs undefined); the facade casts the decoded value.
	schema: Schema.Schema<any, any, never>,
	value: unknown,
	decodeOptions?: {
		readonly onExcessProperty?: "preserve" | "ignore" | "error";
	},
): T {
	try {
		return Schema.decodeUnknownSync(
			schema,
			decodeOptions as Parameters<typeof Schema.decodeUnknownSync>[1],
		)(value) as T;
	} catch (error) {
		if (error instanceof ParseError) {
			const issues = ArrayFormatter.formatErrorSync(error)
				.slice(0, 8)
				.map((issue) => ({
					path: formatIssuePath(issue.path),
					message: sanitizeIssueMessage(issue.message),
				}));
			throw new ContractFailure(
				contractId,
				issues.length > 0
					? issues
					: [{ path: "$", message: "expected valid value" }],
			);
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Reusable field builders mirroring the legacy `validation` helpers.
// ---------------------------------------------------------------------------

/** Non-empty UTF-8 string, trimmed and bounded in bytes (legacy semantics:
 * the old hand-written parsers enforced `Buffer.byteLength`, so multibyte
 * content counts as its UTF-8 size, not its UTF-16 code-unit length). */
function text(max: number): Schema.Schema<string> {
	return Schema.String.pipe(
		Schema.filter(
			(value) =>
				value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max,
			{
				message: () => `expected non-empty string <= ${max} bytes`,
			},
		),
	);
}
/** String bounded in bytes (UTF-8); absent/null become the empty string. */
function boundedText(max: number): Schema.Schema<string> {
	return Schema.String.pipe(
		Schema.filter((value) => Buffer.byteLength(value, "utf8") <= max, {
			message: () => `expected string <= ${max} bytes`,
		}),
	);
}
/** Non-negative integer at or above a floor. */
function integer(min = 0): Schema.Schema<number> {
	return Schema.Number.pipe(
		Schema.filter((value) => Number.isInteger(value) && value >= min, {
			message: () => `expected integer >= ${min}`,
		}),
	);
}
function stringArray(): Schema.Schema<readonly string[]> {
	return Schema.Array(Schema.String);
}

// ---------------------------------------------------------------------------
// Developer-question option / item / answer
// ---------------------------------------------------------------------------

export const DeveloperQuestionOptionSchema: Schema.Schema<DeveloperQuestionOption> =
	Schema.Struct({
		label: text(256),
		value: text(1024),
	});

const questionOptions = Schema.Array(DeveloperQuestionOptionSchema).pipe(
	Schema.filter(
		(options) =>
			options.length <= 16 &&
			new Set(options.map((option) => option.value)).size === options.length,
		{ message: () => "expected at most 16 unique option objects" },
	),
);

export const DeveloperQuestionItemSchema = Schema.Struct({
	description: text(4096),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(questionOptions, {
		exact: true,
		default: () => [],
	}),
});

const MAX_QUESTIONNAIRE_ITEMS = 8;

export const DeveloperQuestionAnswerSchema = Schema.Union(
	Schema.Struct({
		questionId: text(4096),
		kind: Schema.Literal("option", "custom", "cancel"),
		value: Schema.optionalWith(text(8192), { exact: true }),
	}).pipe(
		Schema.filter(
			(answer) => answer.kind === "cancel" || answer.value !== undefined,
			{
				message: () =>
					"option and custom answers require a value; cancel does not",
			},
		),
	),
	Schema.Struct({
		groupId: text(4096),
		kind: Schema.Literal("cancel"),
	}),
	Schema.Struct({
		groupId: text(4096),
		responses: Schema.Array(
			Schema.Struct({
				questionId: text(4096),
				kind: Schema.Literal("option", "custom"),
				value: text(8192),
			}),
		).pipe(
			Schema.filter(
				(responses) =>
					responses.length >= 1 &&
					responses.length <= MAX_QUESTIONNAIRE_ITEMS &&
					new Set(responses.map((item) => item.questionId)).size ===
						responses.length,
				{
					message: () =>
						`expected 1-${MAX_QUESTIONNAIRE_ITEMS} unique responses`,
				},
			),
		),
	}),
);

// ---------------------------------------------------------------------------
// Workflow command (discriminated union on `type`)
// ---------------------------------------------------------------------------

const developerActionSchema = Schema.Struct({
	type: Schema.Literal("developer.action"),
	workflowId: text(4096),
	revision: integer(),
	actionId: text(4096),
	input: Schema.Unknown,
});
const agentQuestionSchema = Schema.Struct({
	type: Schema.Literal("agent.question"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	description: Schema.optionalWith(text(4096), { exact: true }),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(questionOptions, { exact: true }),
	questions: Schema.optionalWith(
		Schema.Array(DeveloperQuestionItemSchema).pipe(
			Schema.filter(
				(items) => items.length >= 1 && items.length <= MAX_QUESTIONNAIRE_ITEMS,
				{
					message: () => `expected 1-${MAX_QUESTIONNAIRE_ITEMS} question items`,
				},
			),
		),
		{ exact: true },
	),
});
const agentQuestionExpireSchema = Schema.Struct({
	type: Schema.Literal("agent.question-expire"),
	workflowId: text(4096),
	questionId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
});
const timerQuestionExpireSchema = Schema.Struct({
	type: Schema.Literal("timer.question-expire"),
	workflowId: text(4096),
	questionId: text(4096),
	timerNonce: text(128),
});
const agentAskSchema = Schema.Struct({
	type: Schema.Literal("agent.ask"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	targetRole: text(4096),
	description: text(4096),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(questionOptions, { exact: true }),
});
const agentAnswerSchema = Schema.Struct({
	type: Schema.Literal("agent.answer"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	questionId: text(4096),
	answerNonce: text(1024),
	answer: text(8192),
});
const agentHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.handoff"),
	runId: text(4096),
	generation: integer(1),
	token: text(1024),
	outcome: Schema.Literal("complete", "blocked", "failed"),
	artifact: Schema.optionalWith(text(4096), { exact: true }),
	message: Schema.optionalWith(text(4096), { exact: true }),
});
const agentResearchHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.research-handoff"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	handoff: Schema.Unknown,
});
const effectResultSchema = Schema.Struct({
	type: Schema.Literal("effect.result"),
	effectId: text(4096),
	lease: text(4096),
	outcome: Schema.Literal("complete", "retry", "failed"),
	data: Schema.Unknown,
	/** Measured handler wall clock, reported on the exported telemetry event.
	 * Optional so existing callers keep decoding unchanged. */
	durationMs: Schema.optional(integer()),
});
const operatorRepairSchema = Schema.Struct({
	type: Schema.Literal("operator.repair"),
	workflowId: text(4096),
	revision: integer(),
	targetStep: text(4096),
	reason: Schema.optionalWith(boundedText(2048), {
		exact: true,
		default: () => "",
	}),
});
const operatorRepinSchema = Schema.Struct({
	type: Schema.Literal("operator.repin"),
	workflowId: text(4096),
	revision: integer(),
});
const operatorMigrateSchema = Schema.Struct({
	type: Schema.Literal("operator.migrate"),
	workflowId: text(4096),
	revision: integer(),
	targetVersion: integer(1),
	reason: Schema.optionalWith(boundedText(2048), {
		exact: true,
		default: () => "",
	}),
});
const operatorResumeSchema = Schema.Struct({
	type: Schema.Literal("operator.resume"),
	workflowId: text(4096),
	revision: integer(),
});

export const WorkflowCommandSchema = Schema.Union(
	developerActionSchema,
	agentQuestionSchema,
	agentQuestionExpireSchema,
	agentAskSchema,
	agentAnswerSchema,
	timerQuestionExpireSchema,
	agentHandoffSchema,
	agentResearchHandoffSchema,
	effectResultSchema,
	operatorRepairSchema,
	operatorRepinSchema,
	operatorMigrateSchema,
	operatorResumeSchema,
);

// ---------------------------------------------------------------------------
// Snapshot / profile / settings
// ---------------------------------------------------------------------------

const stepRefSchema = Schema.Struct({
	id: text(4096),
	version: integer(1),
	behaviorVersion: integer(1),
});
const definitionPinSchema = Schema.Struct({
	id: text(4096),
	version: integer(1),
	digest: text(4096),
	stepRefs: Schema.optionalWith(Schema.Array(stepRefSchema), { exact: true }),
});
const capabilitiesSchema = Schema.Array(
	Schema.Literal(
		"interactive",
		"prompt",
		"persistent-session",
		"run-environment",
		"observe",
		"read-only",
		"shell",
		"edit",
		"runtime-bridge",
	),
);
const profileSchema: Schema.Schema<ResolvedProfile> = Schema.Struct({
	name: text(4096),
	runtime: text(64),
	executable: text(4096),
	model: Schema.optionalWith(text(4096), { exact: true }),
	agent: Schema.optionalWith(text(4096), { exact: true }),
	thinking: Schema.optionalWith(text(4096), { exact: true }),
	tools: stringArray(),
	extensions: stringArray(),
	readOnly: Schema.Boolean,
	capabilities: capabilitiesSchema,
	digest: text(4096),
});
const executionSettingsSchema: Schema.Schema<WorkflowExecutionSettings> =
	Schema.Struct({
		remote: text(256),
		prTool: Schema.NullOr(text(4096)),
		provenance: Schema.Struct({
			source: Schema.Literal(
				"default",
				"environment",
				"user",
				"legacy",
				"project",
			),
			files: stringArray(),
		}),
	});
const settingsPreviewSchema = Schema.Struct({
	settings: executionSettingsSchema,
	fingerprint: text(128),
	revision: integer(),
});
const dialogueStatusSchema = Schema.Literal(
	"pending",
	"answered",
	"cancelled",
	"expired",
);
const dialogueAnswerSchema = Schema.Struct({
	kind: Schema.Literal("option", "custom", "cancel"),
	value: Schema.optionalWith(text(8192), { exact: true }),
});
const dialogueRecordSchema = Schema.Struct({
	id: text(4096),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	description: text(4096),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: questionOptions,
	groupId: Schema.optionalWith(text(4096), { exact: true }),
	timerNonce: Schema.optionalWith(text(128), { exact: true }),
	targetRole: Schema.optionalWith(text(4096), { exact: true }),
	targetRunId: Schema.optionalWith(text(4096), { exact: true }),
	answerNonceHash: Schema.optionalWith(text(128), { exact: true }),
	itemIndex: Schema.optionalWith(integer(), { exact: true }),
	status: dialogueStatusSchema,
	createdAt: text(4096),
	expiresAt: text(4096),
	answeredAt: Schema.optionalWith(text(4096), { exact: true }),
	answer: Schema.optionalWith(dialogueAnswerSchema, { exact: true }),
});
const stepResultsSchema = Schema.Array(
	Schema.Struct({
		runId: text(4096),
		role: text(4096),
		critical: integer(),
		outputDigest: Schema.optionalWith(text(4096), { exact: true }),
	}),
);
const routingSchema = Schema.Struct({
	defaultProfile: text(4096),
	routes: Schema.Array(
		Schema.Struct({
			stepId: text(4096),
			role: Schema.optionalWith(text(4096), { exact: true }),
			profile: profileSchema,
		}),
	),
	diversity: Schema.optionalWith(
		Schema.Array(
			Schema.Struct({
				routes: stringArray(),
				satisfied: Schema.Boolean,
			}),
		),
		{ exact: true },
	),
});
const evidenceSchema = Schema.Array(
	Schema.Struct({ kind: text(4096), path: text(4096), digest: text(4096) }),
);
const loopCountsSchema = Schema.Record({
	key: Schema.String,
	value: integer(),
});
const wikiBaselineSchema = Schema.Struct({
	fingerprint: text(128),
	concepts: Schema.Array(Schema.Struct({ id: text(4096), digest: text(128) })),
});
const sourceBaselineSchema = Schema.Struct({ fingerprint: text(128) });
const repairedSchema = Schema.Struct({
	reason: boundedText(4096),
	fromStep: text(4096),
	at: text(4096),
});
const migratedSchema = Schema.Struct({
	from: definitionPinSchema,
	to: definitionPinSchema,
	reason: boundedText(4096),
	at: text(4096),
});
const repinnedSchema = Schema.Struct({
	fromDigest: text(4096),
	at: text(4096),
});

// ---------------------------------------------------------------------------
// Built-in step input/output contracts (definitions/contracts.ts)
// ---------------------------------------------------------------------------

const MAX_RESEARCH_HANDOFF_CITATIONS = 32;
const MAX_RESEARCH_HANDOFF_DIRECTIVES = 16;
const MAX_RESEARCH_HANDOFF_CLAIMS = 16;
const MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS = 16;

export const FindingsInputSchema = Schema.Struct({
	findings: Schema.Array(
		Schema.Struct({
			id: text(4096),
			severity: Schema.Literal("critical", "warning", "info"),
			detail: text(4096),
			path: text(4096),
			line: integer(1),
		}),
	).pipe(
		Schema.filter(
			(entries) =>
				new Set(entries.map((entry) => entry.id)).size === entries.length,
			{ message: () => "duplicate stable ID" },
		),
	),
});

const researchHandoffDirectiveSchema = Schema.Struct({
	target: text(512),
	intent: Schema.Literal("create", "update"),
	claims: Schema.Array(boundedText(2048)).pipe(
		Schema.filter(
			(claims) =>
				claims.length >= 1 && claims.length <= MAX_RESEARCH_HANDOFF_CLAIMS,
			{
				message: () => `expected at most ${MAX_RESEARCH_HANDOFF_CLAIMS} claims`,
			},
		),
	),
	citations: Schema.optionalWith(
		Schema.Array(boundedText(1024)).pipe(
			Schema.filter(
				(citations) =>
					citations.length <= MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS,
				{
					message: () =>
						`expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS} citations`,
				},
			),
		),
		{ exact: true, default: () => [] },
	),
});

export const ResearchHandoffSchema = Schema.Struct({
	subject: text(512),
	canonicalTarget: Schema.optionalWith(text(512), { exact: true }),
	findings: Schema.optionalWith(boundedText(16384), {
		exact: true,
		default: () => "",
	}),
	directives: Schema.optionalWith(
		Schema.Array(researchHandoffDirectiveSchema).pipe(
			Schema.filter(
				(directives) =>
					directives.length >= 1 &&
					directives.length <= MAX_RESEARCH_HANDOFF_DIRECTIVES,
				{
					message: () =>
						`expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVES} documentation directives`,
				},
			),
		),
		{ exact: true, default: () => [] },
	),
	citations: Schema.optionalWith(
		Schema.Array(boundedText(1024)).pipe(
			Schema.filter(
				(citations) => citations.length <= MAX_RESEARCH_HANDOFF_CITATIONS,
				{
					message: () =>
						`expected at most ${MAX_RESEARCH_HANDOFF_CITATIONS} source citations`,
				},
			),
		),
		{ exact: true, default: () => [] },
	),
	noSourcesUsed: Schema.Boolean,
}).pipe(
	Schema.filter(
		(handoff) => handoff.noSourcesUsed || handoff.citations.length > 0,
		{
			message: () =>
				"expected at least one source citation, or noSourcesUsed set to true",
		},
	),
);

const triageEntrySchema = Schema.Struct({
	role: text(4096),
	reason: text(4096),
	files: stringArray(),
	hunks: Schema.optionalWith(
		Schema.Record({
			key: Schema.String,
			value: Schema.Array(Schema.Number).pipe(
				Schema.filter(
					(ids) =>
						ids.every((id) => Number.isInteger(id) && id >= 1 && id <= 8),
					{ message: () => "invalid scoped hunk IDs" },
				),
			),
		}),
		{ exact: true },
	),
});

export const TriagePlanSchema = Schema.Struct({
	roles: Schema.Array(triageEntrySchema).pipe(
		Schema.filter(
			(entries) =>
				new Set(entries.map((entry) => entry.role)).size === entries.length,
			{ message: () => "duplicate role" },
		),
	),
});

export const PlanDraftSchema = Schema.Struct({
	approach: text(8192),
	files: Schema.Array(
		Schema.Struct({
			path: text(1024),
			change: text(4096),
		}),
	).pipe(
		Schema.filter((files) => files.length >= 1, {
			message: () => "expected at least one planned file",
		}),
	),
	risks: Schema.Array(Schema.Struct({ detail: text(4096) })),
	questions: Schema.Array(Schema.Struct({ detail: text(4096) })),
});

export const PlanResultSchema = Schema.Struct({
	primaryChangeId: text(80),
	summary: Schema.optionalWith(text(16384), { exact: true }),
	artifacts: Schema.optionalWith(stringArray(), { exact: true }),
	risks: Schema.optionalWith(stringArray(), { exact: true }),
	openQuestions: Schema.optionalWith(stringArray(), { exact: true }),
});

export const WorkflowSnapshotSchema = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	workflowId: text(4096),
	revision: integer(),
	definition: definitionPinSchema,
	status: Schema.Literal(
		"active",
		"paused",
		"attention-required",
		"completed",
		"closed",
	),
	currentStep: text(4096),
	step: Schema.Struct({
		attempt: integer(1),
		mode: Schema.optionalWith(Schema.Literal("apply", "fix", "review-fix"), {
			exact: true,
		}),
		activeRunIds: stringArray(),
		completedRunIds: stringArray(),
		selectedRoles: stringArray(),
		testRunStarted: Schema.Boolean,
		context: Schema.optionalWith(Schema.Unknown, { exact: true }),
		results: stepResultsSchema,
	}),
	metadata: Schema.Struct({
		repository: boundedText(4096),
		worktree: text(4096),
		changeId: Schema.optionalWith(boundedText(4096), {
			exact: true,
			default: () => "",
		}),
		branch: boundedText(4096),
		baseBranch: boundedText(4096),
		baseCommit: boundedText(4096),
		workspace: Schema.optionalWith(text(4096), { exact: true }),
		task: Schema.optionalWith(text(65536), { exact: true }),
		ticket: Schema.optionalWith(text(4096), { exact: true }),
		createdAt: text(4096),
		updatedAt: text(4096),
		stepEnteredAt: text(4096),
		wikiRoot: Schema.optionalWith(text(4096), { exact: true }),
		executionSettings: Schema.optionalWith(executionSettingsSchema, {
			exact: true,
		}),
		executionSettingsPreview: Schema.optionalWith(settingsPreviewSchema, {
			exact: true,
		}),
	}),
	routing: routingSchema,
	evidence: evidenceSchema,
	loopCounts: loopCountsSchema,
	attention: stringArray(),
	developerDialogue: Schema.optionalWith(
		Schema.Array(dialogueRecordSchema).pipe(
			Schema.filter((items) => items.length <= 100, {
				message: () => "expected at most 100 dialogue records",
			}),
		),
		{ exact: true, default: () => [] },
	),
	sourceBaseline: Schema.optionalWith(sourceBaselineSchema, { exact: true }),
	wikiBaseline: Schema.optionalWith(wikiBaselineSchema, { exact: true }),
	repaired: Schema.optionalWith(repairedSchema, { exact: true }),
	migrated: Schema.optionalWith(migratedSchema, { exact: true }),
	repinned: Schema.optionalWith(repinnedSchema, { exact: true }),
});
