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
import { Effect, Schema, SchemaGetter } from "effect";
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
	recoveryRecordSchema,
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
	stepRefs: Schema.optionalKey(Schema.Array(stepRefSchema)),
});
// Persisted snapshot capability enum. Extending this list does NOT bump
// STORE_SCHEMA_VERSION: a stage-test start writes `vision` into the resolved
// profile, so a build that predates that literal cannot decode the same
// version-6 store. Upgrade is safe (old snapshots lack the key); rolling the
// release back requires closing or deleting those workflows first
// (STAGE-MIG-002). A tolerant transform is the alternative once an older build
// must keep reading a store a newer one wrote.
const capabilitiesSchema = Schema.Array(
	Schema.Literals([
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
	]),
);
/** Persisted runtime ids: the current runtime plus the retired pane-hosted ids,
 * normalized on read so a snapshot or run written before the multiplexer
 * removal still decodes (multiplexer removal). */
const runtimeSchema: Schema.Codec<RuntimeId, string> = Schema.String.pipe(
	Schema.decodeTo(Schema.Literal("pi-durable"), {
		decode: SchemaGetter.transform(() => "pi-durable" as const),
		encode: SchemaGetter.transform(() => "pi-durable" as const),
	}),
);
const profileSchema = Schema.Struct({
	name: text(4096),
	runtime: runtimeSchema,
	executable: text(4096),
	model: Schema.optionalKey(text(4096)),
	thinking: Schema.optionalKey(text(4096)),
	tools: stringArray(),
	extensions: stringArray(),
	readOnly: Schema.Boolean,
	capabilities: capabilitiesSchema,
	digest: text(4096),
});
const executionSettingsSchema: Schema.Codec<WorkflowExecutionSettings> =
	Schema.Struct({
		remote: text(256),
		prTool: Schema.NullOr(text(4096)),
		provenance: Schema.Struct({
			source: Schema.Literals([
				"default",
				"environment",
				"user",
				"legacy",
				"project",
			]),
			files: stringArray(),
		}),
	});
const settingsPreviewSchema = Schema.Struct({
	settings: executionSettingsSchema,
	fingerprint: text(128),
	revision: integer(),
});
const dialogueStatusSchema = Schema.Literals([
	"pending",
	"answered",
	"cancelled",
	"expired",
]);
const dialogueAnswerSchema = Schema.Struct({
	kind: Schema.Literals(["option", "custom", "cancel"]),
	value: Schema.optionalKey(text(8192)),
});
const classifierDecisionRecordSchema = Schema.Struct({
	id: text(4096),
	at: text(4096),
	integration: text(4096),
	phase: Schema.optionalKey(text(4096)),
	questionId: text(4096),
	model: text(4096),
	input: boundedText(CLASSIFIER_DECISION_INPUT_MAX_BYTES),
	inputTruncated: Schema.Boolean,
	options: Schema.Array(
		Schema.Struct({
			label: text(4096),
			profile: text(4096),
			criteria: Schema.optionalKey(Schema.Unknown),
		}),
	),
	answer: Schema.Struct({
		type: Schema.Literals(["choice", "noul"]),
		choice: Schema.optionalKey(text(4096)),
		// The necessity value of a "noul" answer: every question the
		// classifier asks outside model-pool routing is a necessity question.
		noul: Schema.optionalKey(Schema.Number),
		confidence: Schema.optionalKey(Schema.Number),
		probabilities: Schema.optionalKey(
			Schema.Record(Schema.String, Schema.Number),
		),
	}),
	result: Schema.Struct({
		applied: Schema.Boolean,
		profiles: stringArray(),
		attention: Schema.optionalKey(boundedText(4096)),
	}),
});
const gateDecisionRecordSchema = Schema.Struct({
	id: text(4096),
	at: text(4096),
	stepId: text(4096),
	stage: text(256),
	policy: text(64),
	decision: Schema.Literals(["run", "skip"]),
	forced: Schema.Boolean,
	noul: Schema.optionalKey(Schema.Number),
	reason: Schema.optionalKey(boundedText(4096)),
});
const dialogueRecordSchema = Schema.Struct({
	id: text(4096),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	ident: Schema.optionalKey(text(256)),
	description: text(4096),
	context: Schema.optionalKey(boundedText(4096)),
	options: questionOptions,
	groupId: Schema.optionalKey(text(4096)),
	timerNonce: Schema.optionalKey(text(128)),
	targetRole: Schema.optionalKey(text(4096)),
	targetRunId: Schema.optionalKey(text(4096)),
	answerNonceHash: Schema.optionalKey(text(128)),
	itemIndex: Schema.optionalKey(integer()),
	status: dialogueStatusSchema,
	createdAt: text(4096),
	expiresAt: text(4096),
	answeredAt: Schema.optionalKey(text(4096)),
	answer: Schema.optionalKey(dialogueAnswerSchema),
});
const stepResultsSchema = Schema.Array(
	Schema.Struct({
		runId: text(4096),
		role: text(4096),
		critical: integer(),
		outputDigest: Schema.optionalKey(text(4096)),
	}),
);
const routingSchema = Schema.Struct({
	defaultProfile: text(4096),
	routes: Schema.Array(
		Schema.Struct({
			stepId: text(4096),
			role: Schema.optionalKey(text(4096)),
			profile: profileSchema,
		}),
	),
	diversity: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				routes: stringArray(),
				satisfied: Schema.Boolean,
			}),
		),
	),
});
const evidenceSchema = Schema.Array(
	Schema.Struct({ kind: text(4096), path: text(4096), digest: text(4096) }),
);
const loopCountsSchema = Schema.Record(Schema.String, integer());
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
	reason: Schema.Literals([
		"owner-touched",
		"not-owner",
		"below-minimum-diff",
		"findings-reported",
		"classifier-selected",
		"classifier-skipped",
	]),
});
const verificationScopeRolesSchema = Schema.Array(
	verificationScopeRoleSchema,
).pipe(
	Schema.check(
		Schema.makeFilter((items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES, {
			message: `expected at most ${VERIFICATION_SCOPE_MAX_ROLES} scope roles`,
		}),
	),
);
const verificationScopeRecordSchema = Schema.Struct({
	round: Schema.optionalKey(integer()),
	plan: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				role: text(64),
				files: Schema.Array(
					boundedText(VERIFICATION_SCOPE_MAX_PATH_BYTES),
				).pipe(
					Schema.check(
						Schema.makeFilter(
							(items) => items.length <= VERIFICATION_SCOPE_MAX_FILES,
							{
								message: `expected at most ${VERIFICATION_SCOPE_MAX_FILES} plan files`,
							},
						),
					),
				),
			}),
		).pipe(
			Schema.check(
				Schema.makeFilter(
					(items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES,
					{
						message: `expected at most ${VERIFICATION_SCOPE_MAX_ROLES} plan roles`,
					},
				),
			),
		),
	),
	reported: Schema.optionalKey(
		Schema.Struct({
			round: integer(),
			roles: Schema.Array(text(64)).pipe(
				Schema.check(
					Schema.makeFilter(
						(items) => items.length <= VERIFICATION_SCOPE_MAX_ROLES,
						{
							message: `expected at most ${VERIFICATION_SCOPE_MAX_ROLES} reported roles`,
						},
					),
				),
			),
		}),
	),
	baseline: Schema.optionalKey(
		Schema.Struct({
			round: integer(),
			complete: Schema.Boolean,
			files: Schema.Array(verificationScopeDigestSchema).pipe(
				Schema.check(
					Schema.makeFilter(
						(items) => items.length <= VERIFICATION_SCOPE_MAX_FILES,
						{
							message: `expected at most ${VERIFICATION_SCOPE_MAX_FILES} baseline files`,
						},
					),
				),
			),
		}),
	),
	delta: Schema.optionalKey(
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
				Schema.check(
					Schema.makeFilter(
						(items) => items.length <= VERIFICATION_SCOPE_MAX_FILES,
						{
							message: `expected at most ${VERIFICATION_SCOPE_MAX_FILES} delta files`,
						},
					),
				),
			),
		}),
	),
	decision: Schema.optionalKey(
		Schema.Struct({
			round: integer(),
			mode: Schema.Literals([
				"first-round",
				"scoped",
				"suite-only",
				"full-set",
			]),
			reason: Schema.Literals([
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
			]),
			threshold: integer(),
			touched: integer(),
			changed: integer(),
			baselineCount: integer(),
			rerun: verificationScopeRolesSchema,
			skipped: verificationScopeRolesSchema,
		}),
	),
});
const sourceBaselineSchema = Schema.Struct({ fingerprint: text(128) });
const repairedSchema = Schema.Struct({
	reason: boundedText(4096),
	recovery: Schema.optionalKey(recoveryRecordSchema),
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
			severity: Schema.Literals(["critical", "warning", "info"]),
			detail: text(4096),
			recommendation: Schema.optional(text(4096)),
			path: text(4096),
			line: integer(1),
		}),
	).pipe(
		Schema.check(
			Schema.makeFilter(
				(entries) =>
					new Set(entries.map((entry) => entry.id)).size === entries.length,
				{ message: "duplicate stable ID" },
			),
		),
	),
});

const researchHandoffDirectiveSchema = Schema.Struct({
	target: text(512),
	intent: Schema.Literals(["create", "update"]),
	claims: Schema.Array(boundedText(2048)).pipe(
		Schema.check(
			Schema.makeFilter(
				(claims) =>
					claims.length >= 1 && claims.length <= MAX_RESEARCH_HANDOFF_CLAIMS,
				{
					message: `expected at most ${MAX_RESEARCH_HANDOFF_CLAIMS} claims`,
				},
			),
		),
	),
	citations: Schema.Array(boundedText(1024))
		.pipe(
			Schema.check(
				Schema.makeFilter(
					(citations) =>
						citations.length <= MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS,
					{
						message: `expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS} citations`,
					},
				),
			),
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
});

export const StageTestPlanSchema = Schema.Struct({
	ticketSummary: boundedText(8192),
	/** Optional replay identity (`add-stage-flow-replay`). Additive: an existing
	 * plan without these fields remains a valid exploratory plan. */
	flowId: Schema.optional(boundedText(64)),
	inputs: Schema.optional(Schema.Record(boundedText(64), Schema.Unknown)),
	knowledgeStatus: Schema.Literals(["found", "none"]),
	expectations: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			statement: boundedText(4096),
			source: Schema.Literals(["ticket", "wiki"]),
			priority: Schema.Literals(["critical", "high", "medium", "low"]),
		}),
	).pipe(
		Schema.check(Schema.isMinLength(1)),
		Schema.check(Schema.isMaxLength(50)),
	),
	knowledgeUsed: Schema.Array(
		Schema.Struct({
			concept: boundedText(512),
			trustTier: boundedText(64),
			stale: Schema.Boolean,
		}),
	).pipe(Schema.check(Schema.isMaxLength(100))),
	route: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			application: boundedText(64),
			role: Schema.optional(boundedText(64)),
			action: boundedText(2048),
			expected: boundedText(4096),
			capture: Schema.Array(boundedText(256)).pipe(
				Schema.check(Schema.isMaxLength(30)),
			),
			/** The reviewed block chosen for this route step. A step without one is
			 * an exploratory gap, not a replay candidate. */
			block: Schema.optional(
				Schema.Struct({
					id: boundedText(160),
					version: Schema.optional(boundedText(32)),
					args: Schema.optional(Schema.Record(boundedText(64), Schema.Unknown)),
				}),
			),
			/** A block the tester is to author for this step
			 * (`author-stage-blocks-as-data`). */
			blockToCreate: Schema.optional(
				Schema.Struct({
					id: boundedText(160),
					version: Schema.optional(boundedText(32)),
					args: Schema.optional(Schema.Record(boundedText(64), Schema.Unknown)),
					intent: boundedText(2048),
				}),
			),
			/** An existing approved data block that is close but wrong. */
			blockToAdjust: Schema.optional(
				Schema.Struct({
					id: boundedText(160),
					version: Schema.optional(boundedText(32)),
					args: Schema.optional(Schema.Record(boundedText(64), Schema.Unknown)),
					reason: boundedText(2048),
				}),
			),
			/** Why this step cannot be a block at all: an edge case the planner
			 * has to state. */
			noBlockReason: Schema.optional(boundedText(2048)),
			expectationIds: Schema.optional(
				Schema.Array(boundedText(64)).pipe(
					Schema.check(Schema.isMaxLength(50)),
				),
			),
		}),
	).pipe(
		Schema.check(Schema.isMinLength(1)),
		Schema.check(Schema.isMaxLength(100)),
	),
	asyncWaits: Schema.Array(
		Schema.Struct({
			stepId: boundedText(64),
			condition: boundedText(1024),
			maxSeconds: integer(1).pipe(
				Schema.check(Schema.isLessThanOrEqualTo(600)),
			),
		}),
	).pipe(Schema.check(Schema.isMaxLength(30))),
	createsData: Schema.Boolean,
	dataCreated: Schema.Array(boundedText(1024)).pipe(
		Schema.check(Schema.isMaxLength(30)),
	),
	notTested: Schema.Array(
		Schema.Struct({
			expectationId: Schema.optional(boundedText(64)),
			reason: boundedText(2048),
		}),
	).pipe(Schema.check(Schema.isMaxLength(50))),
});

export const StageTestReportSchema = Schema.Struct({
	expectations: Schema.Array(
		Schema.Struct({
			id: boundedText(64),
			/** The tester's own statement of what it checked
			 * (`remove-stage-test-planner`). Optional in the decoder so a report
			 * persisted by an earlier tier — one verdict per *planned*
			 * expectation — still decodes and its run still resumes; the handoff
			 * guard requires it for every verdict written now. */
			statement: Schema.optional(boundedText(4096)),
			verdict: Schema.Literals(["pass", "fail", "blocked", "inconclusive"]),
			severity: Schema.optional(
				Schema.Literals(["critical", "major", "minor", "info"]),
			),
			expected: boundedText(4096),
			observed: boundedText(8192),
			stepIds: Schema.Array(boundedText(64)).pipe(
				Schema.check(Schema.isMaxLength(100)),
			),
			evidenceIds: Schema.Array(boundedText(64)).pipe(
				Schema.check(Schema.isMaxLength(100)),
			),
		}),
	).pipe(
		Schema.check(Schema.isMinLength(1)),
		Schema.check(Schema.isMaxLength(50)),
	),
	applicationVersions: Schema.Array(
		Schema.Struct({
			application: boundedText(64),
			status: Schema.Literals(["available", "unavailable"]),
			version: Schema.optional(boundedText(256)),
			reason: Schema.optional(boundedText(1024)),
		}).pipe(
			Schema.check(
				Schema.makeFilter(
					(item) =>
						item.status === "available"
							? Boolean(item.version?.trim()) && item.reason === undefined
							: item.version === undefined && Boolean(item.reason?.trim()),
					{
						message:
							"available versions need a version; unavailable versions need a reason",
					},
				),
			),
		),
	).pipe(Schema.check(Schema.isMaxLength(100))),
	createdData: Schema.Array(
		Schema.Struct({
			description: boundedText(1024),
			cleanupHint: Schema.optional(boundedText(2048)),
		}),
	).pipe(Schema.check(Schema.isMaxLength(30))),
	knowledgeObservations: Schema.Array(
		Schema.Struct({
			concept: boundedText(512),
			kind: Schema.Literals(["confirmed", "contradicted", "missing", "new"]),
			statement: Schema.optional(boundedText(2048)),
			observed: Schema.optional(boundedText(2048)),
			suspectedCause: Schema.optional(
				Schema.Literals(["product-change", "regression", "unknown"]),
			),
		}),
	).pipe(Schema.check(Schema.isMaxLength(100))),
	/** The block execution the report rests on (`author-stage-blocks-as-data`):
	 * what ran and what the tester authored. The tester chose the route, so the
	 * claim names the block and the document version rather than a plan step. */
	blocksUsed: Schema.Array(
		Schema.Struct({
			block: boundedText(160),
			version: boundedText(32),
		}),
	)
		.pipe(Schema.check(Schema.isMaxLength(100)))
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	// A created/adjusted claim names the *document*, not just the id and version:
	// the digest `stage_block_save` returned is what the approval publishes, what
	// the promotion refuses to publish over when the draft changed, and what its
	// recovery compares, because a same-version re-save replaces the body
	// (`SEC-005`, `CONC-105`, `CONC-107`, `CONC-108`).
	blocksCreated: Schema.Array(
		Schema.Struct({
			block: boundedText(160),
			version: boundedText(32),
			digest: boundedText(128),
		}),
	)
		.pipe(Schema.check(Schema.isMaxLength(30)))
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	blocksAdjusted: Schema.Array(
		Schema.Struct({
			block: boundedText(160),
			version: boundedText(32),
			digest: boundedText(128),
		}),
	)
		.pipe(Schema.check(Schema.isMaxLength(30)))
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	/** What the tester deliberately did not test, in its own words: the report
	 * no longer reconciles a plan's route steps, so a gap is stated rather than
	 * accounted for (`remove-stage-test-planner`). */
	notTested: Schema.Array(
		Schema.Struct({
			expectationId: Schema.optional(boundedText(64)),
			reason: boundedText(2048),
		}),
	)
		.pipe(Schema.check(Schema.isMaxLength(50)))
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	notes: Schema.optionalKey(boundedText(8192)),
});

export const ResearchHandoffSchema = Schema.Struct({
	subject: text(512),
	canonicalTarget: Schema.optionalKey(text(512)),
	findings: boundedText(16384).pipe(
		Schema.withDecodingDefaultKey(Effect.sync(() => "")),
	),
	directives: Schema.Array(researchHandoffDirectiveSchema)
		.pipe(
			Schema.check(
				Schema.makeFilter(
					(directives) =>
						directives.length >= 1 &&
						directives.length <= MAX_RESEARCH_HANDOFF_DIRECTIVES,
					{
						message: `expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVES} documentation directives`,
					},
				),
			),
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	citations: Schema.Array(boundedText(1024))
		.pipe(
			Schema.check(
				Schema.makeFilter(
					(citations) => citations.length <= MAX_RESEARCH_HANDOFF_CITATIONS,
					{
						message: `expected at most ${MAX_RESEARCH_HANDOFF_CITATIONS} source citations`,
					},
				),
			),
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	noSourcesUsed: Schema.Boolean,
}).pipe(
	Schema.check(
		Schema.makeFilter(
			(handoff) => handoff.noSourcesUsed || handoff.citations.length > 0,
			{
				message:
					"expected at least one source citation, or noSourcesUsed set to true",
			},
		),
	),
);

const triageEntrySchema = Schema.Struct({
	role: text(4096),
	reason: text(4096),
	files: stringArray(),
	hunks: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Array(Schema.Number).pipe(
				Schema.check(
					Schema.makeFilter(
						(ids) =>
							ids.every((id) => Number.isInteger(id) && id >= 1 && id <= 8),
						{ message: "invalid scoped hunk IDs" },
					),
				),
			),
		),
	),
});

export const TriagePlanSchema = Schema.Struct({
	roles: Schema.Array(triageEntrySchema).pipe(
		Schema.check(
			Schema.makeFilter(
				(entries) =>
					new Set(entries.map((entry) => entry.role)).size === entries.length,
				{ message: "duplicate role" },
			),
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
		Schema.check(
			Schema.makeFilter((files) => files.length >= 1, {
				message: "expected at least one planned file",
			}),
		),
	),
	risks: Schema.Array(Schema.Struct({ detail: text(4096) })),
	questions: Schema.Array(Schema.Struct({ detail: text(4096) })),
});

export const PlanResultSchema = Schema.Struct({
	primaryChangeId: text(80),
	summary: Schema.optionalKey(text(16384)),
	artifacts: Schema.optionalKey(stringArray()),
	risks: Schema.optionalKey(stringArray()),
	openQuestions: Schema.optionalKey(stringArray()),
});

// ---------------------------------------------------------------------------
// Workflow blueprint (add-workflow-blueprint-compiler)
// ---------------------------------------------------------------------------

/** The family traits a blueprint declares; the compiled manifest's policy
 * carries exactly this block. Mirrors `WorkflowFamilyTraits` in `registry.ts`
 * (which cannot be imported as a value here without a cycle). */
const blueprintFamilyTraitsSchema = Schema.Struct({
	changeArtifacts: Schema.Literals(["openspec", "none"]),
	planning: Schema.Literals(["none", "single", "fusion"]),
	changeIdentity: Schema.Literals(["planned", "workflow-id", "none"]),
	delivery: Schema.Literals(["pull-request", "none"]),
	startRequirements: Schema.Array(
		Schema.Literals([
			"task",
			"clean-tree",
			"openspec-project",
			"openspec-change",
			"base-commit",
			"rebase-refs",
		]),
	).pipe(
		Schema.check(
			Schema.makeFilter((items) => items.length <= 6, {
				message: "expected at most 6 start requirements",
			}),
		),
	),
	openspecVerifier: Schema.Boolean,
});

const blueprintLoopSchema = Schema.Struct({ maxAttempts: integer(1) });

const blueprintEdgeSchema = Schema.Struct({
	from: text(256),
	outcome: text(256),
	to: text(256),
	loop: Schema.optionalKey(blueprintLoopSchema),
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
	checkoutRequired: Schema.Boolean.pipe(
		Schema.withDecodingDefaultKey(Effect.sync(() => false)),
	),
	verificationRounds: integer(1),
	steps: Schema.Array(text(256)).pipe(
		Schema.check(
			Schema.makeFilter(
				(items) => items.length <= BLUEPRINT_MAX_DECLARED_STEPS,
				{
					message: `expected at most ${BLUEPRINT_MAX_DECLARED_STEPS} blueprint steps`,
				},
			),
		),
	),
	edges: Schema.Array(blueprintEdgeSchema).pipe(
		Schema.check(
			Schema.makeFilter(
				(items) => items.length <= BLUEPRINT_MAX_DECLARED_EDGES,
				{
					message: `expected at most ${BLUEPRINT_MAX_DECLARED_EDGES} blueprint edges`,
				},
			),
		),
	),
});

export type BlueprintInput = Schema.Schema.Type<typeof BlueprintSchema>;

export const WorkflowSnapshotSchema = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	workflowId: text(4096),
	revision: integer(),
	definition: definitionPinSchema,
	status: Schema.Literals([
		"active",
		"paused",
		"attention-required",
		"completed",
		"closed",
	]),
	currentStep: text(4096),
	step: Schema.Struct({
		attempt: integer(1),
		mode: Schema.optionalKey(Schema.Literals(["apply", "fix", "review-fix"])),
		activeRunIds: stringArray(),
		completedRunIds: stringArray(),
		selectedRoles: stringArray(),
		testRunStarted: Schema.Boolean,
		context: Schema.optionalKey(Schema.Unknown),
		results: stepResultsSchema,
	}),
	metadata: Schema.Struct({
		repository: boundedText(4096),
		worktree: text(4096),
		changeId: boundedText(4096).pipe(
			Schema.withDecodingDefaultKey(Effect.sync(() => "")),
		),
		branch: boundedText(4096),
		baseBranch: boundedText(4096),
		baseCommit: boundedText(4096),
		workspace: Schema.optionalKey(text(4096)),
		task: Schema.optionalKey(text(65536)),
		ticket: Schema.optionalKey(text(4096)),
		stage: Schema.optionalKey(boundedText(64)),
		stageSystem: Schema.optionalKey(boundedText(STAGE_SYSTEM_MAX_BYTES)),
		stageWikiProcesses: Schema.optionalKey(
			Schema.Array(boundedText(STAGE_WIKI_PROCESS_MAX_BYTES)),
		),
		stageAccess: Schema.optionalKey(Schema.Literals(["read-only", "writable"])),
		stagePlanApproval: Schema.optionalKey(
			Schema.Literals(["always", "when-writing", "never"]),
		),
		stageTestPlan: Schema.optionalKey(StageTestPlanSchema),
		stageTestReport: Schema.optionalKey(StageTestReportSchema),
		stageTestReportMarkdown: Schema.optionalKey(text(2 * 1024 * 1024)),
		/** What the pinned plan's blocks are, projected from the composed
		 * registry when the plan is accepted: the review shows the title, effect
		 * set and role scope of each block a route step names. Bounded to the
		 * plan's own route size. */
		stagePlanBlocks: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					routeStepId: boundedText(64),
					id: boundedText(160),
					title: Schema.optionalKey(boundedText(512)),
					app: Schema.optionalKey(boundedText(64)),
					effects: Schema.optionalKey(Schema.Array(boundedText(32))),
					roles: Schema.optionalKey(Schema.Array(boundedText(64))),
				}),
			),
		),
		/** The replay identity and evidence links for the optional stage.replay
		 * step. It is a summary only; the result/report/heal JSON stays in the
		 * evidence store. */
		stageReplay: Schema.optionalKey(
			Schema.Struct({
				status: Schema.Literals(["passed", "failed", "ineligible"]),
				flowId: Schema.optionalKey(boundedText(64)),
				planId: Schema.optionalKey(boundedText(128)),
				revision: Schema.optionalKey(integer(0)),
				inputsHash: Schema.optionalKey(boundedText(80)),
				routeHash: Schema.optionalKey(boundedText(80)),
				specHash: Schema.optionalKey(boundedText(80)),
				blockVersions: Schema.optionalKey(
					Schema.Record(boundedText(160), boundedText(32)),
				),
				blockDigests: Schema.optionalKey(
					Schema.Record(boundedText(160), boundedText(80)),
				),
				resultEvidenceId: Schema.optionalKey(boundedText(64)),
				reportEvidenceId: Schema.optionalKey(boundedText(64)),
				healEvidenceId: Schema.optionalKey(boundedText(64)),
				reason: Schema.optionalKey(boundedText(2048)),
				stepCount: Schema.optionalKey(integer(0)),
				durationMs: Schema.optionalKey(integer(0)),
			}),
		),
		stageReplayHeal: Schema.optionalKey(
			Schema.Record(boundedText(256), Schema.Unknown),
		),
		createdAt: text(4096),
		updatedAt: text(4096),
		stepEnteredAt: text(4096),
		selectedPreset: Schema.optionalKey(boundedText(4096)),
		/** The configured app an `env-setup` workflow drafts definitions for. */
		app: Schema.optionalKey(boundedText(4096)),
		/** The env-setup drafts root, pinned at start like `wikiRoot`. */
		setupDraftsDir: Schema.optionalKey(text(4096)),
		/** The promotion journal's per-run authentication secret. */
		setupPromotionSecret: Schema.optionalKey(text(256)),
		/** The write guard's armed baselines, keyed by the run identity. The scope
		 * marker and the scanned entries are optional so a baseline an older build
		 * armed still decodes (and is then reported as needing a restart) rather
		 * than being dropped as an unreadable snapshot. */
		setupGuardBaselines: Schema.optionalKey(
			Schema.Record(
				text(256),
				Schema.Struct({
					configDir: text(4096),
					checkoutDir: text(4096),
					configFingerprint: text(4096),
					checkoutFingerprint: text(4096),
					scope: Schema.optionalKey(boundedText(128)),
					truncated: Schema.optionalKey(Schema.Boolean),
					entries: Schema.optionalKey(
						Schema.Array(
							Schema.Struct({
								path: boundedText(4096),
								kind: Schema.Literals(["d", "f", "l"]),
								size: Schema.optionalKey(integer(0)),
								digest: Schema.optionalKey(boundedText(128)),
								target: Schema.optionalKey(boundedText(4096)),
							}),
						),
					),
				}),
			),
		),
		/** The reviewed digest of every drafted file, recorded when the validation
		 * gate passed: the promotion refuses to publish anything else, so the
		 * developer's approval authorises the bytes that become live and not merely
		 * a path list (the authoring agent can write into the staged root while the
		 * approval waits). Bounded, and never secret content. */
		setupReviewedDrafts: Schema.optionalKey(
			Schema.Record(text(4096), text(128)),
		),
		/** Action -> the target id the validation gate resolved as the default,
		 * recorded when the gate passed (`fix-default-target-after-promotion`). The
		 * smoke check compares the live resolver's answer with this, so "the live
		 * default is what the gate validated" is a checked statement. Bounded to
		 * three actions. */
		setupValidatedDefaults: Schema.optionalKey(
			Schema.Record(text(64), text(512)),
		),
		/** Who started the workflow; absent on snapshots that predate the
		 * attribution, which read as `developer`. */
		startedBy: Schema.optionalKey(
			Schema.Literals(["developer", "orchestrator"]),
		),
		/** The blueprint a custom-shaped workflow was started from
		 * (add-orchestrator-blueprint-workflows): the authored label and rationale
		 * plus the compiled digest the workflow pins. */
		blueprint: Schema.optionalKey(
			Schema.Struct({
				label: boundedText(256),
				rationale: boundedText(4096),
				digest: boundedText(4096),
			}),
		),
		gatePolicies: Schema.optionalKey(
			Schema.Record(Schema.String, Schema.String),
		),
		classifier: Schema.optionalKey(boundedText(4096)),
		wikiRoot: Schema.optionalKey(text(4096)),
		executionSettings: Schema.optionalKey(executionSettingsSchema),
		executionSettingsPreview: Schema.optionalKey(settingsPreviewSchema),
	}),
	routing: routingSchema,
	evidence: evidenceSchema,
	loopCounts: loopCountsSchema,
	attention: stringArray(),
	developerDialogue: Schema.Array(dialogueRecordSchema)
		.pipe(
			Schema.check(
				Schema.makeFilter((items) => items.length <= 100, {
					message: "expected at most 100 dialogue records",
				}),
			),
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	classifierDecisions: Schema.optionalKey(
		Schema.Array(classifierDecisionRecordSchema).pipe(
			Schema.check(
				Schema.makeFilter(
					(items) => items.length <= CLASSIFIER_DECISION_MAX_RECORDS,
					{
						message: `expected at most ${CLASSIFIER_DECISION_MAX_RECORDS} classifier decision records`,
					},
				),
			),
		),
	),
	// A snapshot that has taken no gate decision still decodes, as an empty
	// list: the field is newer than every workflow already on disk.
	gateDecisions: Schema.Array(gateDecisionRecordSchema)
		.pipe(
			Schema.check(
				Schema.makeFilter(
					(items) => items.length <= GATE_DECISION_MAX_RECORDS,
					{
						message: `expected at most ${GATE_DECISION_MAX_RECORDS} gate decision records`,
					},
				),
			),
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
	verificationScope: Schema.optionalKey(verificationScopeRecordSchema),
	sourceBaseline: Schema.optionalKey(sourceBaselineSchema),
	wikiBaseline: Schema.optionalKey(wikiBaselineSchema),
	repaired: Schema.optionalKey(repairedSchema),
	repinned: Schema.optionalKey(repinnedSchema),
});
