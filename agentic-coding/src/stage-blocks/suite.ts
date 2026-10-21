// Suite manifest schema and the independent-entry runner
// (`add-stage-flow-replay`, design D7 / tasks section 9). A suite names
// several flow entries that replay together as a regression/CI batch. It is
// never mapped to a `core.stage-test-plan` report — that mapping is the
// single-flow `stage.replay` workflow step's job (`flow.ts`,
// `replay-report.ts`); a suite's own result is an aggregate pass/fail over its
// entries, each of which still goes through the same single-flow approval and
// eligibility gate its id would go through alone.
import fs from "node:fs";
import path from "node:path";
import { STAGE_FLOW_DIRECTORY } from "./flow.ts";
import type { FlowRegistryEntry } from "./flow-registry.ts";
import type { JsonValue } from "./schema.ts";
import { validateSchemaValue } from "./schema.ts";

export const STAGE_SUITE_EXTENSION = ".suite.json";
export const STAGE_SUITE_MANIFEST_VERSION = 1 as const;

const SUITE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_SUITE_FLOWS = 50;

export interface SuiteFlowEntry {
	/** Defaults to `${flowId}#${index}` so the same flow id may appear more
	 * than once (different data sets) with a still-unique entry identity. */
	readonly id: string;
	readonly flowId: string;
	readonly inputs?: Readonly<Record<string, JsonValue>>;
	/** Declares that this entry's data is not independent of another entry's;
	 * refuses `parallel: true` for the whole suite. */
	readonly sharedData?: boolean;
	/** A fixed-order hint; also refuses `parallel: true`. Entries always run in
	 * the manifest's own array order when the suite is not parallel, so this
	 * is declarative (it documents *why* the suite is sequential) rather than
	 * a second scheduler. */
	readonly sequence?: number;
	/** Entry ids this entry depends on. Each must name an entry declared
	 * earlier in `flows`, and any non-empty list refuses `parallel: true`. */
	readonly dependsOn?: readonly string[];
}

export interface SuiteManifest {
	readonly version: 1;
	readonly suiteId: string;
	readonly parallel: boolean;
	readonly stopOnFailure: boolean;
	readonly flows: readonly SuiteFlowEntry[];
}

export interface SuiteIssue {
	readonly code: string;
	readonly message: string;
	readonly field?: string;
}

function issue(code: string, message: string, field?: string): SuiteIssue {
	return { code, message, ...(field === undefined ? {} : { field }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a suite manifest's shape, including the independence
 * rule (task 9.1, 9.4). Pure: no filesystem access, so the HTTP route and a
 * standalone CI script share one validator over the bytes each reads itself. */
export function parseSuiteManifest(value: unknown): {
	readonly manifest?: SuiteManifest;
	readonly issues: readonly SuiteIssue[];
} {
	if (!isRecord(value))
		return {
			issues: [issue("suite-manifest", "the suite manifest must be an object")],
		};
	const issues: SuiteIssue[] = [];
	if (value.version !== 1)
		issues.push(
			issue("suite-version", "the suite manifest version must be 1", "version"),
		);
	if (
		typeof value.suiteId !== "string" ||
		!SUITE_ID_PATTERN.test(value.suiteId)
	)
		issues.push(
			issue(
				"suite-id",
				"suiteId must start with a lowercase letter and contain lowercase letters, digits or -",
				"suiteId",
			),
		);
	if (value.parallel !== undefined && typeof value.parallel !== "boolean")
		issues.push(
			issue("suite-parallel", "parallel must be a boolean", "parallel"),
		);
	if (
		value.stopOnFailure !== undefined &&
		typeof value.stopOnFailure !== "boolean"
	)
		issues.push(
			issue(
				"suite-stop-on-failure",
				"stopOnFailure must be a boolean",
				"stopOnFailure",
			),
		);
	const parallel = value.parallel === true;
	const stopOnFailure = value.stopOnFailure === true;
	if (!Array.isArray(value.flows) || value.flows.length === 0)
		issues.push(
			issue("suite-flows", "a suite needs at least one flow entry", "flows"),
		);
	else if (value.flows.length > MAX_SUITE_FLOWS)
		issues.push(
			issue(
				"suite-flow-limit",
				`a suite may declare at most ${MAX_SUITE_FLOWS} entries`,
				"flows",
			),
		);
	const flows: SuiteFlowEntry[] = [];
	const seenIds = new Set<string>();
	if (Array.isArray(value.flows))
		value.flows.forEach((raw: unknown, index: number) => {
			const field = `flows.${index}`;
			if (!isRecord(raw)) {
				issues.push(
					issue("suite-flow-entry", `entry ${index} must be an object`, field),
				);
				return;
			}
			if (typeof raw.flowId !== "string" || raw.flowId.trim() === "") {
				issues.push(
					issue(
						"suite-flow-id",
						`entry ${index} needs a flowId`,
						`${field}.flowId`,
					),
				);
				return;
			}
			const id =
				typeof raw.id === "string" && raw.id.trim() !== ""
					? raw.id
					: `${raw.flowId}#${index}`;
			if (seenIds.has(id)) {
				issues.push(
					issue(
						"suite-entry-id",
						`entry id ${id} is declared more than once`,
						`${field}.id`,
					),
				);
				return;
			}
			if (raw.inputs !== undefined && !isRecord(raw.inputs)) {
				issues.push(
					issue(
						"suite-flow-inputs",
						`entry ${id} inputs must be an object`,
						`${field}.inputs`,
					),
				);
				return;
			}
			if (raw.sharedData !== undefined && typeof raw.sharedData !== "boolean") {
				issues.push(
					issue(
						"suite-shared-data",
						`entry ${id} sharedData must be a boolean`,
						`${field}.sharedData`,
					),
				);
				return;
			}
			if (
				raw.sequence !== undefined &&
				(typeof raw.sequence !== "number" || !Number.isInteger(raw.sequence))
			) {
				issues.push(
					issue(
						"suite-sequence",
						`entry ${id} sequence must be an integer`,
						`${field}.sequence`,
					),
				);
				return;
			}
			if (
				raw.dependsOn !== undefined &&
				(!Array.isArray(raw.dependsOn) ||
					raw.dependsOn.some((entry: unknown) => typeof entry !== "string"))
			) {
				issues.push(
					issue(
						"suite-depends-on",
						`entry ${id} dependsOn must be a list of entry ids`,
						`${field}.dependsOn`,
					),
				);
				return;
			}
			seenIds.add(id);
			flows.push({
				id,
				flowId: raw.flowId,
				...(raw.inputs === undefined
					? {}
					: { inputs: raw.inputs as Readonly<Record<string, JsonValue>> }),
				...(raw.sharedData === undefined ? {} : { sharedData: raw.sharedData }),
				...(raw.sequence === undefined ? {} : { sequence: raw.sequence }),
				...(raw.dependsOn === undefined
					? {}
					: { dependsOn: raw.dependsOn as readonly string[] }),
			});
		});
	const idsSoFar = new Set<string>();
	for (const entry of flows) {
		for (const dependency of entry.dependsOn ?? []) {
			if (dependency === entry.id)
				issues.push(
					issue(
						"suite-depends-on-self",
						`entry ${entry.id} cannot depend on itself`,
						"flows",
					),
				);
			else if (!idsSoFar.has(dependency))
				issues.push(
					issue(
						"suite-depends-on-unknown",
						`entry ${entry.id} depends on ${dependency}, which is unknown or declared later; dependsOn must name an earlier entry`,
						"flows",
					),
				);
		}
		idsSoFar.add(entry.id);
	}
	if (parallel)
		for (const entry of flows)
			if (
				entry.sharedData === true ||
				entry.sequence !== undefined ||
				(entry.dependsOn?.length ?? 0) > 0
			)
				issues.push(
					issue(
						"suite-parallel-dependency",
						`entry ${entry.id} declares shared data, a fixed sequence or a dependency, so the suite cannot run with parallel: true`,
						"parallel",
					),
				);
	if (issues.length > 0) return { issues };
	return {
		manifest: {
			version: 1,
			suiteId: value.suiteId as string,
			parallel,
			stopOnFailure,
			flows,
		},
		issues: [],
	};
}

export type SuiteEntryStatus = "passed" | "failed" | "refused" | "skipped";

export interface SuiteEntryResult {
	readonly id: string;
	readonly flowId: string;
	readonly status: SuiteEntryStatus;
	readonly inputsHash?: string;
	readonly routeHash?: string;
	readonly evidenceIds?: readonly string[];
	readonly reportEvidenceId?: string;
	readonly resultEvidenceId?: string;
	readonly code?: string;
	readonly error?: string;
}

export interface SuiteRunOptions {
	/** Bounded by the caller from `browser.max_sessions` and a CI worker
	 * setting (task 9.3); always at least 1. */
	readonly maxWorkers: number;
}

export interface SuiteRunResult {
	readonly status: "passed" | "failed";
	readonly entries: readonly SuiteEntryResult[];
}

/** Runs every manifest entry through the caller-supplied `run`, honoring
 * `parallel` (bounded concurrency) and `stopOnFailure` (no new entry starts
 * once one has failed or been refused; the rest are marked `skipped`). Pure
 * orchestration: `run` is where the actual flow identity/approval/execution
 * happens, so this is unit-testable without a browser or a workflow. */
export async function runSuiteEntries(
	manifest: SuiteManifest,
	run: (entry: SuiteFlowEntry) => Promise<SuiteEntryResult>,
	options: SuiteRunOptions,
): Promise<SuiteRunResult> {
	const results = new Map<string, SuiteEntryResult>();
	let stopped = false;
	const workerCount = manifest.parallel
		? Math.max(1, Math.min(options.maxWorkers, manifest.flows.length))
		: 1;
	const queue = [...manifest.flows];
	async function worker(): Promise<void> {
		for (;;) {
			const entry = queue.shift();
			if (entry === undefined) return;
			if (stopped) {
				results.set(entry.id, {
					id: entry.id,
					flowId: entry.flowId,
					status: "skipped",
				});
				continue;
			}
			const result = await run(entry);
			results.set(entry.id, result);
			if (
				(result.status === "failed" || result.status === "refused") &&
				manifest.stopOnFailure
			)
				stopped = true;
		}
	}
	await Promise.all(
		Array.from({ length: Math.max(1, workerCount) }, () => worker()),
	);
	const entries = manifest.flows.map(
		(entry) =>
			results.get(entry.id) ?? {
				id: entry.id,
				flowId: entry.flowId,
				status: "skipped" as const,
			},
	);
	const status = entries.every((entry) => entry.status === "passed")
		? ("passed" as const)
		: ("failed" as const);
	return { status, entries };
}

export interface SuiteRegistryEntry {
	readonly manifest: SuiteManifest;
	readonly path: string;
}

/** Scan `stage-flows/*.suite.json` (siblings of the per-flow directories) the
 * same way `readFlowRegistry` scans `stage-flows/<flowId>/flow.json`, so the
 * CI/checked-in gate (`scripts/check-stage-flows.ts`) can validate both with
 * one pass over the same directory. */
export function readSuiteRegistry(root: string): {
	readonly entries: readonly SuiteRegistryEntry[];
	readonly issues: readonly SuiteIssue[];
} {
	const directory = path.join(root, STAGE_FLOW_DIRECTORY);
	const entries: SuiteRegistryEntry[] = [];
	const issues: SuiteIssue[] = [];
	if (!fs.existsSync(directory)) return { entries, issues };
	for (const name of fs.readdirSync(directory).sort()) {
		if (!name.endsWith(STAGE_SUITE_EXTENSION)) continue;
		const suitePath = path.join(directory, name);
		if (!fs.statSync(suitePath).isFile()) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(suitePath, "utf8"));
		} catch (error) {
			issues.push(
				issue(
					"suite-manifest-invalid",
					`stage-flows/${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
					`stage-flows/${name}`,
				),
			);
			continue;
		}
		const { manifest, issues: parseIssues } = parseSuiteManifest(raw);
		if (manifest === undefined) {
			issues.push(...parseIssues);
			continue;
		}
		const expectedId = name.slice(0, -STAGE_SUITE_EXTENSION.length);
		if (manifest.suiteId !== expectedId)
			issues.push(
				issue(
					"suite-file-mismatch",
					`stage-flows/${name} names suite ${manifest.suiteId}, not ${expectedId}`,
					`stage-flows/${name}`,
				),
			);
		entries.push({ manifest, path: suitePath });
	}
	return { entries, issues };
}

/** Cross-checks one suite manifest's entries against the current flow
 * registry: each `flowId` must exist, and an entry's own `inputs` (when it
 * declares them) must validate against that flow's input schema (task 9.2).
 * `inputsHash`/route-hash/stage approval against one approved plan revision
 * is the HTTP route's job (`stageReplaySuite`); registry cross-checking never
 * needs a workflow. */
export function suiteRegistryIssues(
	manifest: SuiteManifest,
	flowEntries: readonly FlowRegistryEntry[],
): readonly SuiteIssue[] {
	const issues: SuiteIssue[] = [];
	for (const entry of manifest.flows) {
		const flow = flowEntries.find(
			(candidate) => candidate.manifest.flowId === entry.flowId,
		);
		if (flow === undefined) {
			issues.push(
				issue(
					"suite-flow-unknown",
					`entry ${entry.id} names flow ${entry.flowId}, which is not saved under stage-flows`,
					"flows",
				),
			);
			continue;
		}
		if (entry.inputs !== undefined)
			for (const problem of validateSchemaValue(
				flow.manifest.inputSchema,
				entry.inputs,
				`flows.${entry.id}.inputs`,
			))
				issues.push(
					issue(
						"suite-flow-inputs",
						`entry ${entry.id}: ${problem.message}`,
						problem.path,
					),
				);
	}
	return issues;
}
