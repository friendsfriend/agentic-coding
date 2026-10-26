// Wire shapes for compiled flow replay (`add-stage-flow-replay`). The result
// contract is deliberately separate from the stage journal: the process writes
// a bounded result, the server ingests its events, and only then does a report
// exist.

import { Schema } from "effect";

const text = (max: number) =>
	Schema.String.pipe(
		Schema.check(Schema.isMinLength(1)),
		Schema.check(Schema.isMaxLength(max)),
	);
const hash = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
	Schema.check(Schema.isMaxLength(80)),
);
const nonNegative = Schema.Number.pipe(
	Schema.check(
		Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, {
			message: "expected a non-negative integer",
		}),
	),
);

export const stageReplayRequestSchema = Schema.Struct({
	flowId: Schema.optional(text(64)),
	/** Runs several flow entries as one regression/CI batch instead of one
	 * named flow (`add-stage-flow-replay`, design D7). Mutually exclusive
	 * with `flowId`. */
	suiteId: Schema.optional(text(64)),
	stage: Schema.optional(text(64)),
	inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	dryRun: Schema.optional(Schema.Boolean),
	role: Schema.optional(text(128)),
}).pipe(
	Schema.check(
		Schema.makeFilter(
			(request) =>
				(request.flowId === undefined) !== (request.suiteId === undefined),
			{
				message: "a replay request needs exactly one of flowId or suiteId",
			},
		),
	),
);
export type StageReplayRequest = typeof stageReplayRequestSchema.Type;

export const stageFlowsRequestSchema = Schema.Struct({
	stage: Schema.optional(text(64)),
	query: Schema.optional(
		Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
	),
	limit: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter(
					(value) => Number.isInteger(value) && value > 0 && value <= 100,
					{
						message: "limit must be an integer between 1 and 100",
					},
				),
			),
		),
	),
});
export type StageFlowsRequest = typeof stageFlowsRequestSchema.Type;

export const replayEventSchema = Schema.Struct({
	index: nonNegative,
	routeStepId: text(64),
	block: text(160),
	version: text(32),
	app: Schema.optional(text(64)),
	role: Schema.optional(text(128)),
	url: Schema.optional(text(2048)),
	subStep: text(512),
	status: Schema.Literals(["passed", "failed"]),
	durationMs: nonNegative,
	expected: Schema.optional(text(4096)),
	observed: Schema.optional(text(4096)),
	captures: Schema.optional(Schema.Record(text(128), text(1024))),
	evidence: Schema.optional(Schema.Array(text(256))),
	error: Schema.optional(text(4096)),
});
export type ReplayEvent = typeof replayEventSchema.Type;

export const replayResultSchema = Schema.Struct({
	version: Schema.Literal(1),
	flowId: text(64),
	planId: Schema.optional(text(128)),
	revision: Schema.optional(nonNegative),
	stage: Schema.optional(text(64)),
	routeHash: hash,
	inputsHash: hash,
	status: Schema.Literals(["passed", "failed"]),
	startedAt: text(64),
	durationMs: nonNegative,
	steps: Schema.Array(
		Schema.Struct({
			index: nonNegative,
			routeStepId: text(64),
			block: text(160),
			version: text(32),
			app: Schema.optional(text(64)),
			status: Schema.Literals(["passed", "failed", "skipped"]),
			durationMs: nonNegative,
			outputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
			evidence: Schema.optional(Schema.Array(text(256))),
			error: Schema.optional(text(4096)),
		}),
	),
	events: Schema.optional(Schema.Array(replayEventSchema)),
	error: Schema.optional(text(4096)),
	heal: Schema.optional(Schema.Unknown),
});
export type ReplayResult = typeof replayResultSchema.Type;

export interface StageReplayStepResponse {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly status: "passed" | "failed" | "skipped";
	readonly durationMs: number;
	readonly outputs?: Readonly<Record<string, unknown>>;
	readonly journalIds: readonly number[];
	readonly evidenceIds: readonly string[];
	readonly error?: string;
}

export interface StageReplayResponse {
	readonly flowId: string;
	readonly planId?: string;
	readonly revision?: number;
	readonly inputsHash: string;
	/** The input values this replay used: the caller's, or the flow's own
	 * recorded example when the request named none. Values, never secrets. */
	readonly inputs: Readonly<Record<string, unknown>>;
	readonly routeHash: string;
	readonly specHash: string;
	readonly stage: string;
	readonly status: "passed" | "failed";
	readonly startedAt: string;
	readonly durationMs: number;
	readonly steps: readonly StageReplayStepResponse[];
	readonly failure?: {
		readonly index: number;
		readonly routeStepId: string;
		readonly block: string;
		readonly version: string;
		readonly message: string;
		readonly retryable: boolean;
	};
	readonly heal?: Readonly<Record<string, unknown>>;
	readonly resultEvidenceId?: string;
	readonly blockVersions?: Readonly<Record<string, string>>;
	readonly blockDigests?: Readonly<Record<string, string>>;
	readonly dryRun?: {
		readonly eligible: boolean;
		readonly issues: readonly {
			readonly code: string;
			readonly message: string;
			readonly field?: string;
		}[];
		readonly inputSchema?: Readonly<Record<string, unknown>>;
		readonly inputs: Readonly<Record<string, unknown>>;
	};
	readonly issues?: readonly {
		readonly code: string;
		readonly message: string;
		readonly field?: string;
	}[];
}

export interface StageFlowsResponse {
	readonly version: 1;
	readonly flows: readonly {
		readonly flowId: string;
		readonly title: string;
		readonly stage: string;
		readonly applications: readonly string[];
		readonly roles: readonly string[];
		readonly routeHash: string;
		readonly specHash: string;
		readonly inputSchema: Readonly<Record<string, unknown>>;
		readonly blockVersions: Readonly<Record<string, string>>;
	}[];
	readonly total: number;
	readonly issues: readonly {
		readonly code: string;
		readonly message: string;
		readonly field?: string;
	}[];
}

export interface StageSuiteEntryResponse {
	readonly id: string;
	readonly flowId: string;
	readonly status: "passed" | "failed" | "refused" | "skipped";
	readonly inputsHash?: string;
	readonly routeHash?: string;
	readonly evidenceIds?: readonly string[];
	readonly reportEvidenceId?: string;
	readonly resultEvidenceId?: string;
	readonly code?: string;
	readonly error?: string;
}

export interface StageSuiteResponse {
	readonly suiteId: string;
	readonly stage: string;
	readonly parallel: boolean;
	readonly stopOnFailure: boolean;
	readonly status: "passed" | "failed";
	readonly startedAt: string;
	readonly durationMs: number;
	readonly entries: readonly StageSuiteEntryResponse[];
	readonly resultEvidenceId?: string;
	readonly issues?: readonly {
		readonly code: string;
		readonly message: string;
		readonly field?: string;
	}[];
}
