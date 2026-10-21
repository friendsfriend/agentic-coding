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
	RuntimeId,
	WorkflowExecutionSettings,
} from "../contracts/workflow.ts";
import {
	CLASSIFIER_DECISION_INPUT_MAX_BYTES,
	CLASSIFIER_DECISION_MAX_RECORDS,
	GATE_DECISION_MAX_RECORDS,
	questionOptions,
	STAGE_SYSTEM_MAX_BYTES,
	STAGE_WIKI_PROCESS_MAX_BYTES,
	VERIFICATION_SCOPE_DIGEST_LENGTH,
	VERIFICATION_SCOPE_MAX_FILES,
	VERIFICATION_SCOPE_MAX_PATH_BYTES,
	VERIFICATION_SCOPE_MAX_ROLES,
} from "../contracts/workflow.ts";

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
// Persisted snapshot capability enum. Extending this list does NOT bump
// STORE_SCHEMA_VERSION: a stage-test start writes `vision` into the resolved
// profile, so a build that predates that literal cannot decode the same
// version-6 store. Upgrade is safe (old snapshots lack the key); rolling the
// release back requires closing or deleting those workflows first
// (STAGE-MIG-002). A tolerant transform is the alternative once an older build
// must keep reading a store a newer one wrote.
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
		"vision",
	),
);
/** Persisted runtime ids: the current runtime plus the retired pane-hosted ids,
 * normalized on read so a snapshot or run written before the multiplexer
 * removal still decodes (multiplexer removal). */
const runtimeSchema: Schema.Schema<RuntimeId, string> = Schema.transform(
	Schema.String,
	Schema.Literal("pi-durable"),
	{
		decode: () => "pi-durable" as const,
		encode: () => "pi-durable" as const,
	},
);
const profileSchema = Schema.Struct({
	name: text(4096),
	runtime: runtimeSchema,
	executable: text(4096),
	model: Schema.optionalWith(text(4096), { exact: true }),
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
const classifierDecisionRecordSchema = Schema.Struct({
	id: text(4096),
	at: text(4096),
	integration: text(4096),
	phase: Schema.optionalWith(text(4096), { exact: true }),
	questionId: text(4096),
	model: text(4096),
	input: boundedText(CLASSIFIER_DECISION_INPUT_MAX_BYTES),
	inputTruncated: Schema.Boolean,
	options: Schema.Array(
		Schema.Struct({
			label: text(4096),
			profile: text(4096),
			criteria: Schema.optionalWith(Schema.Unknown, { exact: true }),
		}),
	),
	answer: Schema.Struct({
		type: Schema.Literal("choice", "noul"),
		choice: Schema.optionalWith(text(4096), { exact: true }),
		// The necessity value of a "noul" answer: every question the
		// classifier asks outside model-pool routing is a necessity question.
		noul: Schema.optionalWith(Schema.Number, { exact: true }),
		confidence: Schema.optionalWith(Schema.Number, { exact: true }),
		probabilities: Schema.optionalWith(
			Schema.Record({ key: Schema.String, value: Schema.Number }),
			{ exact: true },
		),
	}),
	result: Schema.Struct({
		applied: Schema.Boolean,
		profiles: stringArray(),
		attention: Schema.optionalWith(boundedText(4096), { exact: true }),
	}),
});
const gateDecisionRecordSchema = Schema.Struct({
	id: text(4096),
	at: text(4096),
	stepId: text(4096),
	stage: text(256),
	policy: text(64),
	decision: Schema.Literal("run", "skip"),
	forced: Schema.Boolean,
	noul: Schema.optionalWith(Schema.Number, { exact: true }),
	reason: Schema.optionalWith(boundedText(4096), { exact: true }),
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
/** The re-verification scope record (role-scoped re-verification). Every list is
 * capped at the record's own bound — one entry per verifier role, at most
 * `VERIFICATION_SCOPE_MAX_FILES` files or delta entries — so a record beyond the
 * caps is refused instead of stored truncated, and a snapshot that carries it
 * still decodes on a reader that predates it (`onExcessProperty: "preserve"`). */
const verificationScopeDigestSchema = Schema.Struct({
	path: boundedText(VERIFICATION_SCOPE_MAX_PATH_BYTES),
	raw: text(VERIFICATION_SCOPE_DIGEST_LENGTH),
	normalized: text(VERIFICATION_SCOPE_DIGEST_LENGTH),
});
const verificationScopeRoleSchema = Schema.Struct({
	role: text(64),
	reason: Schema.Literal(
		"owner-touched",
		"not-owner",
		"below-minimum-diff",
		"findings-reported",
		"classifier-selected",
		"classifier-skipped",
	),
});
const verificationScopeRolesSchema = Schema.Array(
	verificationScopeRoleSchema,
).pipe(
	Schema.filter((items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES, {
		message: () =>
			`expected at most ${VERIFICATION_SCOPE_MAX_ROLES} scope roles`,
	}),
);
const verificationScopeRecordSchema = Schema.Struct({
	round: Schema.optionalWith(integer(), { exact: true }),
	plan: Schema.optionalWith(
		Schema.Array(
			Schema.Struct({
				role: text(64),
				files: Schema.Array(
					boundedText(VERIFICATION_SCOPE_MAX_PATH_BYTES),
				).pipe(
					Schema.filter(
						(items) => items.length <= VERIFICATION_SCOPE_MAX_FILES,
						{
							message: () =>
								`expected at most ${VERIFICATION_SCOPE_MAX_FILES} plan files`,
						},
					),
				),
			}),
		).pipe(
			Schema.filter((items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES, {
				message: () =>
					`expected at most ${VERIFICATION_SCOPE_MAX_ROLES} plan roles`,
			}),
		),
		{ exact: true },
	),
	reported: Schema.optionalWith(
		Schema.Struct({
			round: integer(),
			roles: Schema.Array(text(64)).pipe(
				Schema.filter((items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES, {
					message: () =>
						`expected at most ${VERIFICATION_SCOPE_MAX_ROLES} reported roles`,
				}),
			),
		}),
		{ exact: true },
	),
	baseline: Schema.optionalWith(
		Schema.Struct({
			round: integer(),
			complete: Schema.Boolean,
			files: Schema.Array(verificationScopeDigestSchema).pipe(
				Schema.filter((items) => items.length <= VERIFICATION_SCOPE_MAX_FILES, {
					message: () =>
						`expected at most ${VERIFICATION_SCOPE_MAX_FILES} baseline files`,
				}),
			),
		}),
		{ exact: true },
	),
	delta: Schema.optionalWith(
		Schema.Struct({
			round: integer(),
			complete: Schema.Boolean,
			threshold: integer(),
			files: Schema.Array(
				Schema.Struct({
					path: boundedText(VERIFICATION_SCOPE_MAX_PATH_BYTES),
					substantive: Schema.Boolean,
				}),
			).pipe(
				Schema.filter((items) => items.length <= VERIFICATION_SCOPE_MAX_FILES, {
					message: () =>
						`expected at most ${VERIFICATION_SCOPE_MAX_FILES} delta files`,
				}),
			),
		}),
		{ exact: true },
	),
	decision: Schema.optionalWith(
		Schema.Struct({
			round: integer(),
			mode: Schema.Literal("first-round", "scoped", "suite-only", "full-set"),
			reason: Schema.Literal(
				"no-previous-round",
				"owner-touched",
				"below-minimum-diff",
				"findings-reported",
				"baseline-unusable",
				"delta-unusable",
				"no-plan-ownership",
				"unowned-touched-file",
				"shared-touched-file",
				"reported-role-outside-catalog",
			),
			threshold: integer(),
			touched: integer(),
			changed: integer(),
			baselineCount: integer(),
			rerun: verificationScopeRolesSchema,
			skipped: verificationScopeRolesSchema,
		}),
		{ exact: true },
	),
});
const sourceBaselineSchema = Schema.Struct({ fingerprint: text(128) });
const repairedSchema = Schema.Struct({
	reason: boundedText(4096),
	fromStep: text(4096),
	at: text(4096),
	// The repair's effect, recorded since efficiency backlog item 11: the ids it
	// expired and retired, and the workflow's repair count. Optional, so a
	// snapshot written before them still decodes unchanged.
	expiredEffects: Schema.optional(stringArray()),
	retiredRuns: Schema.optional(stringArray()),
	count: Schema.optional(integer()),
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
			recommendation: Schema.optional(text(4096)),
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

export const StageTestPlanSchema = Schema.Struct({
	ticketSummary: boundedText(8192),
	/** Optional replay identity (`add-stage-flow-replay`). Additive: an existing
	 * plan without these fields remains a valid exploratory plan. */
	flowId: Schema.optional(boundedText(64)),
	inputs: Schema.optional(
		Schema.Record({ key: boundedText(64), value: Schema.Unknown }),
	),
	knowledgeStatus: Schema.Literal("found", "none"),
	expectations: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			statement: boundedText(4096),
			source: Schema.Literal("ticket", "wiki"),
			priority: Schema.Literal("critical", "high", "medium", "low"),
		}),
	).pipe(Schema.minItems(1), Schema.maxItems(50)),
	knowledgeUsed: Schema.Array(
		Schema.Struct({
			concept: boundedText(512),
			trustTier: boundedText(64),
			stale: Schema.Boolean,
		}),
	).pipe(Schema.maxItems(100)),
	route: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			application: boundedText(64),
			role: Schema.optional(boundedText(64)),
			action: boundedText(2048),
			expected: boundedText(4096),
			capture: Schema.Array(boundedText(256)).pipe(Schema.maxItems(30)),
			/** The reviewed block chosen for this route step. A step without one is
			 * an exploratory gap, not a replay candidate. */
			block: Schema.optional(
				Schema.Struct({
					id: boundedText(160),
					version: Schema.optional(boundedText(32)),
					args: Schema.optional(
						Schema.Record({ key: boundedText(64), value: Schema.Unknown }),
					),
				}),
			),
			expectationIds: Schema.optional(
				Schema.Array(boundedText(64)).pipe(Schema.maxItems(50)),
			),
		}),
	).pipe(Schema.minItems(1), Schema.maxItems(100)),
	asyncWaits: Schema.Array(
		Schema.Struct({
			stepId: boundedText(64),
			condition: boundedText(1024),
			maxSeconds: integer(1).pipe(Schema.lessThanOrEqualTo(600)),
		}),
	).pipe(Schema.maxItems(30)),
	createsData: Schema.Boolean,
	dataCreated: Schema.Array(boundedText(1024)).pipe(Schema.maxItems(30)),
	notTested: Schema.Array(
		Schema.Struct({
			expectationId: Schema.optional(boundedText(64)),
			reason: boundedText(2048),
		}),
	).pipe(Schema.maxItems(50)),
});

export const StageTestReportSchema = Schema.Struct({
	expectations: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			verdict: Schema.Literal("pass", "fail", "blocked", "inconclusive"),
			severity: Schema.optional(
				Schema.Literal("critical", "major", "minor", "info"),
			),
			expected: boundedText(4096),
			observed: boundedText(8192),
			stepIds: Schema.Array(boundedText(64)).pipe(Schema.maxItems(100)),
			evidenceIds: Schema.Array(boundedText(64)).pipe(Schema.maxItems(100)),
		}),
	).pipe(Schema.minItems(1), Schema.maxItems(50)),
	applicationVersions: Schema.Array(
		Schema.Struct({
			application: boundedText(64),
			status: Schema.Literal("available", "unavailable"),
			version: Schema.optional(boundedText(256)),
			reason: Schema.optional(boundedText(1024)),
		}).pipe(
			Schema.filter(
				(item) =>
					item.status === "available"
						? Boolean(item.version?.trim()) && item.reason === undefined
						: item.version === undefined && Boolean(item.reason?.trim()),
				{
					message: () =>
						"available versions need a version; unavailable versions need a reason",
				},
			),
		),
	).pipe(Schema.maxItems(100)),
	createdData: Schema.Array(
		Schema.Struct({
			description: boundedText(1024),
			cleanupHint: Schema.optional(boundedText(2048)),
		}),
	).pipe(Schema.maxItems(30)),
	knowledgeObservations: Schema.Array(
		Schema.Struct({
			concept: boundedText(512),
			kind: Schema.Literal("confirmed", "contradicted", "missing", "new"),
			statement: Schema.optional(boundedText(2048)),
			observed: Schema.optional(boundedText(2048)),
			suspectedCause: Schema.optional(
				Schema.Literal("product-change", "regression", "unknown"),
			),
		}),
	).pipe(Schema.maxItems(100)),
	notTested: Schema.Array(
		Schema.Struct({
			expectationId: Schema.optional(boundedText(64)),
			reason: boundedText(2048),
		}),
	).pipe(Schema.maxItems(50)),
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

// ---------------------------------------------------------------------------
// Workflow blueprint (add-workflow-blueprint-compiler)
// ---------------------------------------------------------------------------

/** The family traits a blueprint declares; the compiled manifest's policy
 * carries exactly this block. Mirrors `WorkflowFamilyTraits` in `registry.ts`
 * (which cannot be imported as a value here without a cycle). */
const blueprintFamilyTraitsSchema = Schema.Struct({
	changeArtifacts: Schema.Literal("openspec", "none"),
	planning: Schema.Literal("none", "single", "fusion"),
	changeIdentity: Schema.Literal("planned", "workflow-id", "none"),
	delivery: Schema.Literal("pull-request", "none"),
	startRequirements: Schema.Array(
		Schema.Literal(
			"task",
			"clean-tree",
			"openspec-project",
			"openspec-change",
			"base-commit",
			"rebase-refs",
		),
	).pipe(
		Schema.filter((items) => items.length <= 6, {
			message: () => "expected at most 6 start requirements",
		}),
	),
	openspecVerifier: Schema.Boolean,
});

const blueprintLoopSchema = Schema.Struct({ maxAttempts: integer(1) });

const blueprintEdgeSchema = Schema.Struct({
	from: text(256),
	outcome: text(256),
	to: text(256),
	loop: Schema.optionalWith(blueprintLoopSchema, { exact: true }),
});

/** Sanity caps on the two model-authored arrays. The compiler rejects more than
 * `MAX_BLUEPRINT_STEPS` logical steps with its own diagnostic, so the cap only
 * has to be high enough to let that diagnostic fire while keeping decode and
 * the compiler's scans bounded. */
const BLUEPRINT_MAX_DECLARED_STEPS = 64;
const BLUEPRINT_MAX_DECLARED_EDGES = 256;

/** A logical workflow description (add-workflow-blueprint-compiler): label,
 * rationale, repository family traits, whether the checkout is required, the
 * logical steps, the logical edges with optional loop bounds, and the
 * verification round count. The compiler (`blueprints/compiler.ts`) turns one
 * into a validated manifest; routing, triage-routing and gate steps are never
 * declared here. Unknown properties are rejected (`decodeBlueprint` decodes
 * with `onExcessProperty: "error"`), so a mistyped field is never silently
 * dropped from the persisted manifest. */
export const BlueprintSchema = Schema.Struct({
	label: text(256),
	rationale: boundedText(4096),
	traits: blueprintFamilyTraitsSchema,
	checkoutRequired: Schema.optionalWith(Schema.Boolean, {
		exact: true,
		default: () => false,
	}),
	verificationRounds: integer(1),
	steps: Schema.Array(text(256)).pipe(
		Schema.filter((items) => items.length <= BLUEPRINT_MAX_DECLARED_STEPS, {
			message: () =>
				`expected at most ${BLUEPRINT_MAX_DECLARED_STEPS} blueprint steps`,
		}),
	),
	edges: Schema.Array(blueprintEdgeSchema).pipe(
		Schema.filter((items) => items.length <= BLUEPRINT_MAX_DECLARED_EDGES, {
			message: () =>
				`expected at most ${BLUEPRINT_MAX_DECLARED_EDGES} blueprint edges`,
		}),
	),
});

export type BlueprintInput = Schema.Schema.Type<typeof BlueprintSchema>;

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
		stage: Schema.optionalWith(boundedText(64), { exact: true }),
		stageSystem: Schema.optionalWith(boundedText(STAGE_SYSTEM_MAX_BYTES), {
			exact: true,
		}),
		stageWikiProcesses: Schema.optionalWith(
			Schema.Array(boundedText(STAGE_WIKI_PROCESS_MAX_BYTES)),
			{ exact: true },
		),
		stageAccess: Schema.optionalWith(Schema.Literal("read-only", "writable"), {
			exact: true,
		}),
		stagePlanApproval: Schema.optionalWith(
			Schema.Literal("always", "when-writing", "never"),
			{ exact: true },
		),
		stageTestPlan: Schema.optionalWith(StageTestPlanSchema, { exact: true }),
		stageTestReport: Schema.optionalWith(StageTestReportSchema, {
			exact: true,
		}),
		stageTestReportMarkdown: Schema.optionalWith(text(2 * 1024 * 1024), {
			exact: true,
		}),
		/** The replay identity and evidence links for the optional stage.replay
		 * step. It is a summary only; the result/report/heal JSON stays in the
		 * evidence store. */
		stageReplay: Schema.optionalWith(
			Schema.Struct({
				status: Schema.Literal("passed", "failed", "ineligible"),
				flowId: Schema.optionalWith(boundedText(64), { exact: true }),
				planId: Schema.optionalWith(boundedText(128), { exact: true }),
				revision: Schema.optionalWith(integer(0), { exact: true }),
				inputsHash: Schema.optionalWith(boundedText(80), { exact: true }),
				routeHash: Schema.optionalWith(boundedText(80), { exact: true }),
				specHash: Schema.optionalWith(boundedText(80), { exact: true }),
				blockVersions: Schema.optionalWith(
					Schema.Record({ key: boundedText(160), value: boundedText(32) }),
					{ exact: true },
				),
				blockDigests: Schema.optionalWith(
					Schema.Record({ key: boundedText(160), value: boundedText(80) }),
					{ exact: true },
				),
				resultEvidenceId: Schema.optionalWith(boundedText(64), { exact: true }),
				reportEvidenceId: Schema.optionalWith(boundedText(64), { exact: true }),
				healEvidenceId: Schema.optionalWith(boundedText(64), { exact: true }),
				reason: Schema.optionalWith(boundedText(2048), { exact: true }),
				stepCount: Schema.optionalWith(integer(0), { exact: true }),
				durationMs: Schema.optionalWith(integer(0), { exact: true }),
			}),
			{ exact: true },
		),
		stageReplayHeal: Schema.optionalWith(
			Schema.Record({ key: boundedText(256), value: Schema.Unknown }),
			{ exact: true },
		),
		createdAt: text(4096),
		updatedAt: text(4096),
		stepEnteredAt: text(4096),
		selectedPreset: Schema.optionalWith(boundedText(4096), { exact: true }),
		/** The configured app an `env-setup` workflow drafts definitions for. */
		app: Schema.optionalWith(boundedText(4096), { exact: true }),
		/** The env-setup drafts root, pinned at start like `wikiRoot`. */
		setupDraftsDir: Schema.optionalWith(text(4096), { exact: true }),
		/** The promotion journal's per-run authentication secret. */
		setupPromotionSecret: Schema.optionalWith(text(256), { exact: true }),
		/** The write guard's armed baselines, keyed by the run identity. The scope
		 * marker and the scanned entries are optional so a baseline an older build
		 * armed still decodes (and is then reported as needing a restart) rather
		 * than being dropped as an unreadable snapshot. */
		setupGuardBaselines: Schema.optionalWith(
			Schema.Record({
				key: text(256),
				value: Schema.Struct({
					configDir: text(4096),
					checkoutDir: text(4096),
					configFingerprint: text(4096),
					checkoutFingerprint: text(4096),
					scope: Schema.optionalWith(boundedText(128), { exact: true }),
					truncated: Schema.optionalWith(Schema.Boolean, { exact: true }),
					entries: Schema.optionalWith(
						Schema.Array(
							Schema.Struct({
								path: boundedText(4096),
								kind: Schema.Literal("d", "f", "l"),
								size: Schema.optionalWith(integer(0), { exact: true }),
								digest: Schema.optionalWith(boundedText(128), { exact: true }),
								target: Schema.optionalWith(boundedText(4096), { exact: true }),
							}),
						),
						{ exact: true },
					),
				}),
			}),
			{ exact: true },
		),
		/** The reviewed digest of every drafted file, recorded when the validation
		 * gate passed: the promotion refuses to publish anything else, so the
		 * developer's approval authorises the bytes that become live and not merely
		 * a path list (the authoring agent can write into the staged root while the
		 * approval waits). Bounded, and never secret content. */
		setupReviewedDrafts: Schema.optionalWith(
			Schema.Record({ key: text(4096), value: text(128) }),
			{ exact: true },
		),
		/** Action -> the target id the validation gate resolved as the default,
		 * recorded when the gate passed (`fix-default-target-after-promotion`). The
		 * smoke check compares the live resolver's answer with this, so "the live
		 * default is what the gate validated" is a checked statement. Bounded to
		 * three actions. */
		setupValidatedDefaults: Schema.optionalWith(
			Schema.Record({ key: text(64), value: text(512) }),
			{ exact: true },
		),
		/** Who started the workflow; absent on snapshots that predate the
		 * attribution, which read as `developer`. */
		startedBy: Schema.optionalWith(
			Schema.Literal("developer", "orchestrator"),
			{ exact: true },
		),
		/** The blueprint a custom-shaped workflow was started from
		 * (add-orchestrator-blueprint-workflows): the authored label and rationale
		 * plus the compiled digest the workflow pins. */
		blueprint: Schema.optionalWith(
			Schema.Struct({
				label: boundedText(256),
				rationale: boundedText(4096),
				digest: boundedText(4096),
			}),
			{ exact: true },
		),
		gatePolicies: Schema.optionalWith(
			Schema.Record({ key: Schema.String, value: Schema.String }),
			{ exact: true },
		),
		classifier: Schema.optionalWith(boundedText(4096), { exact: true }),
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
	classifierDecisions: Schema.optionalWith(
		Schema.Array(classifierDecisionRecordSchema).pipe(
			Schema.filter(
				(items) => items.length <= CLASSIFIER_DECISION_MAX_RECORDS,
				{
					message: () =>
						`expected at most ${CLASSIFIER_DECISION_MAX_RECORDS} classifier decision records`,
				},
			),
		),
		{ exact: true },
	),
	// A snapshot that has taken no gate decision still decodes, as an empty
	// list: the field is newer than every workflow already on disk.
	gateDecisions: Schema.optionalWith(
		Schema.Array(gateDecisionRecordSchema).pipe(
			Schema.filter((items) => items.length <= GATE_DECISION_MAX_RECORDS, {
				message: () =>
					`expected at most ${GATE_DECISION_MAX_RECORDS} gate decision records`,
			}),
		),
		{ exact: true, default: () => [] },
	),
	verificationScope: Schema.optionalWith(verificationScopeRecordSchema, {
		exact: true,
	}),
	sourceBaseline: Schema.optionalWith(sourceBaselineSchema, { exact: true }),
	wikiBaseline: Schema.optionalWith(wikiBaselineSchema, { exact: true }),
	repaired: Schema.optionalWith(repairedSchema, { exact: true }),
	repinned: Schema.optionalWith(repinnedSchema, { exact: true }),
});
