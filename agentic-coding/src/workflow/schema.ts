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
import {
	boundedText,
	integer,
	stringArray,
	text,
} from "../contracts/decode.ts";
import type {
	ResolvedProfile,
	WorkflowExecutionSettings,
} from "../contracts/workflow.ts";
import { questionOptions } from "../contracts/workflow.ts";

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
	ident: Schema.optionalWith(text(256), { exact: true }),
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
		selectedPreset: Schema.optionalWith(boundedText(4096), { exact: true }),
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
