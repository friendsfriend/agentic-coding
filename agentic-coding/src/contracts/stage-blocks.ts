// Wire shapes for the typed stage-block layer. The plan body deliberately
// carries `args` and `inputs` as JSON objects: their real contract is the
// registry-derived JSON Schema, which is validated by the pure plan validator
// before any browser opens. Duplicating that schema in Effect Schema here would
// let the transport and the runner disagree.

import { Schema } from "effect";

const text = (max: number) =>
	Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max));

export const stageBlockStepRequestSchema = Schema.Struct({
	id: Schema.optional(text(64)),
	block: text(160),
	version: Schema.optional(text(32)),
	args: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	save: Schema.optional(Schema.Boolean),
});
export type StageBlockStepRequest = typeof stageBlockStepRequestSchema.Type;

export const stageBlockPlanRequestSchema = Schema.Struct({
	planId: Schema.optional(text(128)),
	flowId: Schema.optional(text(64)),
	revision: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value >= 0, {
				message: () => "expected a non-negative integer",
			}),
		),
	),
	inputs: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	steps: Schema.Array(stageBlockStepRequestSchema).pipe(
		Schema.minItems(1),
		Schema.maxItems(100),
	),
});
export type StageBlockPlanRequest = typeof stageBlockPlanRequestSchema.Type;

export const stageBlocksRequestSchema = Schema.Struct({
	id: Schema.optional(text(160)),
	query: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
	app: Schema.optional(text(64)),
	effect: Schema.optional(Schema.Literal("read", "write", "destructive")),
	full: Schema.optional(Schema.Boolean),
	limit: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
});
export type StageBlocksRequest = typeof stageBlocksRequestSchema.Type;

export const stageRunRequestSchema = Schema.Struct({
	/** A standalone block plan or an approved `core.stage-test-plan@1`; the
	 * server decodes the latter before projecting its route. */
	plan: Schema.Unknown,
	session: Schema.optional(text(64)),
	stage: Schema.optional(text(64)),
	stageApp: Schema.optional(text(64)),
	role: Schema.optional(text(128)),
	dryRun: Schema.optional(Schema.Boolean),
	save: Schema.optional(Schema.Boolean),
	/** Arguments for the route steps whose block this run authored
	 * (`blockToCreate`/`blockToAdjust`), keyed by route step id. The plan cannot
	 * know a block's parameters before the tester has written it, so these are
	 * merged over the step's plan args; a step naming an approved `block` never
	 * takes them. */
	draftArgs: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	/** The workflow revision the plan was approved at. */
	approvedRevision: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value >= 0, {
				message: () => "expected a non-negative integer",
			}),
		),
	),
});
export type StageRunRequest = typeof stageRunRequestSchema.Type;

export const stageBlockSaveRequestSchema = Schema.Struct({
	/** The reviewed JSON document (`StageDataBlockDocument`). Its shape is owned
	 * by the pure validator, which reports bounded issues instead of failing a
	 * transport decode. */
	document: Schema.Unknown,
	session: Schema.optional(text(64)),
	// The draft's plan id and revision are not request fields: the engine derives
	// them from the workflow's pinned plan and its own revision, so a tester can
	// never label a draft with a plan the run did not have (`OSV-017`,
	// `OSV-020`).
});
export type StageBlockSaveRequest = typeof stageBlockSaveRequestSchema.Type;

export interface StageBlockSaveResponse {
	readonly status: "draft";
	readonly stage: string;
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly effects: readonly string[];
	readonly digest: string;
	/** The approved version this draft replaces, when it replaces one. */
	readonly replaced?: { readonly version: string };
	/** The execution proofs this run already holds for the draft. */
	readonly proofs: readonly {
		readonly stage: string;
		readonly runId: string;
		readonly status: "passed" | "failed";
		readonly at: string;
	}[];
	readonly warnings?: readonly string[];
}

export interface StageBlockCatalogEntry {
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly roles: readonly string[];
	readonly title: string;
	readonly description: string;
	readonly exportName?: string;
	readonly effects: readonly string[];
	readonly idempotent: boolean;
	readonly requires: readonly string[];
	readonly provides: readonly string[];
	readonly deprecated?: {
		readonly replacementId?: string;
		readonly removalDate?: string;
	};
	readonly params?: Readonly<Record<string, unknown>>;
	readonly returns?: Readonly<Record<string, unknown>>;
	readonly examples?: readonly Readonly<Record<string, unknown>>[];
	readonly contractTest?: string;
	/** `data` is a reviewed JSON document; a draft lives in its authoring
	 * workflow's store until review promotes it. */
	readonly kind?: "checked-in" | "data";
	readonly status?: "draft";
	readonly postcondition?: string;
	readonly document?: Readonly<Record<string, unknown>>;
	readonly digest?: string;
}

export interface StageBlocksResponse {
	readonly version: 1;
	readonly mode: "compact" | "full";
	readonly blocks: readonly StageBlockCatalogEntry[];
	readonly total: number;
	/** Store diagnostics: an approved or draft document that was refused. The
	 * catalog is what could be loaded, never a silent partial success. */
	readonly diagnostics?: readonly {
		readonly code: string;
		readonly message: string;
		readonly id?: string;
	}[];
}

export interface StageBlockPlanIssueResponse {
	readonly code: string;
	readonly message: string;
	readonly stepIndex?: number;
	readonly routeStepId?: string;
	readonly block?: string;
	readonly field?: string;
}

export interface StageRunStepResponse {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly app: string;
	readonly role?: string;
	readonly status: "passed" | "failed" | "skipped";
	readonly durationMs: number;
	readonly retries: number;
	readonly outputs?: Readonly<Record<string, unknown>>;
	readonly journalIds: readonly number[];
	readonly evidenceIds: readonly string[];
	readonly error?: string;
}

export interface StageRunResponse {
	readonly planId: string;
	readonly flowId?: string;
	readonly revision?: number;
	readonly inputsHash: string;
	readonly stage: string;
	readonly status: "passed" | "failed";
	readonly steps: readonly StageRunStepResponse[];
	readonly versions: Readonly<Record<string, string>>;
	readonly durationMs: number;
	readonly failure?: {
		readonly stepIndex: number;
		readonly routeStepId: string;
		readonly block: string;
		readonly version: string;
		readonly message: string;
		readonly retryable: boolean;
	};
	readonly issues?: readonly StageBlockPlanIssueResponse[];
	readonly saved?: {
		readonly flowId: string;
		readonly specPath: string;
		readonly manifestPath: string;
		readonly routeHash: string;
		readonly specHash: string;
		readonly inputsHash: string;
		readonly existing?: boolean;
	};
	readonly dryRun?: {
		readonly ok: boolean;
		readonly issues: readonly StageBlockPlanIssueResponse[];
		readonly versions: Readonly<Record<string, string>>;
		readonly inputSchema?: Readonly<Record<string, unknown>>;
	};
}
