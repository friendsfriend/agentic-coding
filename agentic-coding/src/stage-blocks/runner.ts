// The linear plan runner. It resolves references, executes one reviewed block
// per step and records the sub-steps the block emitted. It has no browser
// knowledge: the server supplies a StageContext host, the Playwright fixture
// supplies another, and the tests supply a fake.

import type {
	BlockAssertion,
	BlockLocator,
	BlockPage,
	BlockStepEvent,
	StageApiClient,
	StageContext,
} from "./define-block.ts";
import type {
	NormalizedStageBlockPlan,
	NormalizedStageBlockStep,
	StageBlockPlanIssue,
} from "./plan.ts";
import { isWholeBinding, type JsonValue, readPath } from "./schema.ts";

export interface StageBlockContextHost {
	readonly page: BlockPage;
	readonly expect: (locator: BlockLocator) => BlockAssertion;
	readonly app: string;
	readonly role?: string;
	readonly stage: string;
	readonly appUrl: string;
	readonly api?: StageApiClient;
	secret(name: string): string;
	capture(
		label: string,
		options?: { readonly ref?: string; readonly view?: boolean },
	): Promise<string>;
	close?(): Promise<void> | void;
}

export interface StageBlockJournalEntry {
	readonly planId: string;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly subStep: string;
	readonly status: "passed" | "failed";
	readonly expected?: string;
	readonly observed?: string;
	readonly captures?: Readonly<Record<string, string>>;
	readonly evidence: readonly string[];
	readonly durationMs: number;
	readonly error?: string;
	readonly knowledge?: BlockStepEvent["knowledge"];
}

export interface StageBlockJournal {
	append(entry: StageBlockJournalEntry): Promise<{ seq: number }>;
}

export interface StageBlockFailureEvidence {
	readonly evidenceIds: readonly string[];
	readonly observed?: string;
	readonly scope?: string;
}

export interface StageBlockStepResult {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly app: string;
	readonly role?: string;
	readonly status: "passed" | "failed" | "skipped";
	readonly durationMs: number;
	readonly retries: number;
	readonly outputs?: Readonly<Record<string, JsonValue>>;
	readonly journalIds: readonly number[];
	readonly evidenceIds: readonly string[];
	readonly error?: string;
}

export interface StageBlockRunResult {
	readonly planId: string;
	readonly flowId?: string;
	readonly revision?: number;
	readonly inputsHash: string;
	readonly stage: string;
	readonly status: "passed" | "failed";
	readonly steps: readonly StageBlockStepResult[];
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
	readonly issues?: readonly StageBlockPlanIssue[];
}

export interface RunStageBlockPlanOptions {
	readonly plan: NormalizedStageBlockPlan;
	readonly stage: string;
	readonly contextFor: (
		step: NormalizedStageBlockStep,
	) => Promise<StageBlockContextHost>;
	readonly journal?: StageBlockJournal;
	readonly failureEvidence?: (input: {
		readonly step: NormalizedStageBlockStep;
		readonly context: StageBlockContextHost;
		readonly error: unknown;
		readonly lastPassingStep?: string;
	}) => Promise<StageBlockFailureEvidence>;
	readonly now?: () => number;
	readonly maxIssueCount?: number;
}

interface AttemptState {
	readonly events: BlockStepEvent[];
	readonly journalIds: number[];
	readonly evidenceIds: string[];
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveRunValue(
	value: JsonValue,
	inputs: Readonly<Record<string, JsonValue>>,
	outputs: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
	routeStepId: string,
): JsonValue {
	if (typeof value === "string") {
		if (!value.includes("{{")) return value;
		if (!isWholeBinding(value))
			throw new StageBlockContractError(
				"block-binding-invalid",
				`${JSON.stringify(value)} is not a whole binding`,
			);
		const input = /^\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
		if (input) {
			const name = input[1] as string;
			if (!Object.hasOwn(inputs, name))
				throw new StageBlockContractError(
					"block-input-missing",
					`plan input ${name} is not declared`,
				);
			return inputs[name] as JsonValue;
		}
		const output =
			/^\{\{\s*steps\.([A-Za-z0-9][A-Za-z0-9_-]*)\.outputs\.([A-Za-z0-9_.-]+)\s*\}\}$/.exec(
				value,
			);
		if (!output)
			throw new StageBlockContractError(
				"block-binding-invalid",
				"binding is not an input or output reference",
			);
		const dependency = output[1] as string;
		const path = output[2] as string;
		const produced = outputs.get(dependency);
		const resolved =
			produced === undefined ? undefined : readPath(produced, path);
		if (resolved === undefined)
			throw new StageBlockContractError(
				"block-output-missing",
				`step ${routeStepId} cannot read ${dependency}'s output ${path}; the step did not produce it`,
			);
		return resolved as JsonValue;
	}
	if (Array.isArray(value))
		return value.map((entry) =>
			resolveRunValue(entry, inputs, outputs, routeStepId),
		);
	if (value !== null && typeof value === "object") {
		const resolved: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value))
			resolved[key] = resolveRunValue(
				entry as JsonValue,
				inputs,
				outputs,
				routeStepId,
			);
		return resolved;
	}
	return value;
}

function isRetryable(step: NormalizedStageBlockStep, error: unknown): boolean {
	if (step.definition.idempotent !== true) return false;
	if (!step.definition.effects.every((effect) => effect === "read"))
		return false;
	// A contract/definition bug is not transient. Only a browser/action failure
	// is retried at this layer; the browser adapter already classifies its own
	// timeouts.
	if (error instanceof StageBlockContractError) return false;
	return true;
}

export class StageBlockContractError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageBlockContractError";
	}
}

function makeContext(
	host: StageBlockContextHost,
	state: AttemptState,
	journal: StageBlockJournal | undefined,
	entryOf: (event: BlockStepEvent) => StageBlockJournalEntry,
	now: () => number,
): StageContext {
	let openStep = false;
	let stepEvidence: string[] = [];
	const context: StageContext = {
		page: host.page,
		expect: host.expect,
		app: host.app,
		...(host.role === undefined ? {} : { role: host.role }),
		stage: host.stage,
		appUrl: host.appUrl,
		...(host.api === undefined ? {} : { api: host.api }),
		run: {
			planId: "",
			routeStepId: "",
			blockId: "",
			blockVersion: "",
			index: 0,
		},
		step: async <T>(
			label: string,
			fn: () => Promise<T>,
			details?: Parameters<StageContext["step"]>[2],
		): Promise<T> => {
			if (openStep)
				throw new StageBlockContractError(
					"block-step-nested",
					"a block sub-step cannot open another sub-step",
				);
			openStep = true;
			stepEvidence = [];
			const startedAt = now();
			const event: BlockStepEvent = {
				label,
				status: "passed",
				durationMs: 0,
				evidence: [],
			};
			let result: T | undefined;
			let failure: unknown;
			try {
				result = await fn();
			} catch (error) {
				failure = error;
			}
			try {
				const resolved =
					details === undefined
						? undefined
						: typeof details === "function"
							? details()
							: details;
				const completed: BlockStepEvent = {
					...event,
					status: failure === undefined ? "passed" : "failed",
					durationMs: Math.max(0, now() - startedAt),
					...(resolved?.expected === undefined
						? {}
						: { expected: resolved.expected }),
					...(resolved?.observed === undefined
						? {}
						: { observed: resolved.observed }),
					...(resolved?.captures === undefined
						? {}
						: { captures: resolved.captures }),
					...(resolved?.knowledge === undefined
						? {}
						: { knowledge: resolved.knowledge }),
					...(failure === undefined ? {} : { error: messageOf(failure) }),
					evidence: [...stepEvidence],
				};
				state.events.push(completed);
				state.evidenceIds.push(...completed.evidence);
				if (journal !== undefined) {
					const written = await journal.append(entryOf(completed));
					state.journalIds.push(written.seq);
				}
			} catch (journalError) {
				openStep = false;
				throw new StageBlockContractError(
					"block-journal-failed",
					`the sub-step ${label} could not be recorded: ${messageOf(journalError)}`,
				);
			}
			openStep = false;
			if (failure !== undefined) throw failure;
			return result as T;
		},
		capture: async (label, options) => {
			if (!openStep)
				throw new StageBlockContractError(
					"block-capture-without-step",
					`capture ${label} must happen inside a block sub-step`,
				);
			const evidence = await host.capture(label, options);
			if (evidence.trim() === "")
				throw new StageBlockContractError(
					"block-capture-invalid",
					`capture ${label} did not return an evidence id`,
				);
			stepEvidence.push(evidence);
			return evidence;
		},
		secret: (name) => host.secret(name),
	};
	return context;
}

/** Execute the plan. The caller validates and normalizes it first; this function
 * never opens a browser on an invalid plan. */
export async function runStageBlockPlan(
	options: RunStageBlockPlanOptions,
): Promise<StageBlockRunResult> {
	const startedAt = (options.now ?? Date.now)();
	const results: StageBlockStepResult[] = [];
	const completedOutputs = new Map<
		string,
		Readonly<Record<string, JsonValue>>
	>();
	let failure: StageBlockRunResult["failure"];
	let lastPassingStep: string | undefined;
	const issueBound = options.maxIssueCount ?? 20;
	const issues: StageBlockPlanIssue[] = [];
	const pushIssue = (entry: StageBlockPlanIssue) => {
		if (issues.length < issueBound) issues.push(entry);
	};
	for (const [index, step] of options.plan.steps.entries()) {
		if (failure !== undefined) {
			results.push({
				index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				app: step.definition.app,
				...(step.definition.roles?.[0] === undefined
					? {}
					: { role: step.definition.roles[0] }),
				status: "skipped",
				durationMs: 0,
				retries: 0,
				journalIds: [],
				evidenceIds: [],
			});
			continue;
		}
		let host: StageBlockContextHost;
		try {
			host = await options.contextFor(step);
		} catch (error) {
			const message = messageOf(error);
			failure = {
				stepIndex: index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				message,
				retryable: false,
			};
			results.push({
				index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				app: step.definition.app,
				status: "failed",
				durationMs: 0,
				retries: 0,
				journalIds: [],
				evidenceIds: [],
				error: message,
			});
			continue;
		}
		const stepStartedAt = (options.now ?? Date.now)();
		let state: AttemptState = { events: [], journalIds: [], evidenceIds: [] };
		let retries = 0;
		let outputs: Readonly<Record<string, JsonValue>> | undefined;
		let error: unknown;
		let succeeded = false;
		const entryOf = (event: BlockStepEvent): StageBlockJournalEntry => ({
			planId: options.plan.planId,
			routeStepId: step.id,
			block: step.definition.id,
			version: step.definition.version,
			subStep: event.label,
			status: event.status,
			...(event.expected === undefined ? {} : { expected: event.expected }),
			...(event.observed === undefined ? {} : { observed: event.observed }),
			...(event.captures === undefined ? {} : { captures: event.captures }),
			evidence: event.evidence,
			durationMs: event.durationMs,
			...(event.error === undefined ? {} : { error: event.error }),
			...(event.knowledge === undefined ? {} : { knowledge: event.knowledge }),
		});
		do {
			const context = makeContext(
				host,
				state,
				options.journal,
				entryOf,
				options.now ?? Date.now,
			);
			const runContext: StageContext = {
				...context,
				run: {
					planId: options.plan.planId,
					...(options.plan.revision === undefined
						? {}
						: { revision: options.plan.revision }),
					...(options.plan.flowId === undefined
						? {}
						: { flowId: options.plan.flowId }),
					routeStepId: step.id,
					blockId: step.definition.id,
					blockVersion: step.definition.version,
					index,
				},
			};
			try {
				const resolvedArgs = resolveRunValue(
					step.args as Record<string, JsonValue>,
					options.plan.inputs,
					completedOutputs,
					step.id,
				) as Record<string, JsonValue>;
				outputs = await step.definition.run(runContext, resolvedArgs);
				if (state.events.length === 0)
					throw new StageBlockContractError(
						"block-no-step",
						`block ${step.definition.id} emitted no sub-step`,
					);
				succeeded = true;
			} catch (caught) {
				error = caught;
				if (state.events.length === 0) {
					// A block that fails before it records anything still leaves an
					// auditable failure entry; the contract only fails if it also emitted
					// no sub-step.
					const event: BlockStepEvent = {
						label: "block failed",
						status: "failed",
						durationMs: 0,
						error: messageOf(caught),
						evidence: [],
					};
					state.events.push(event);
					if (options.journal !== undefined) {
						try {
							const written = await options.journal.append(entryOf(event));
							state.journalIds.push(written.seq);
						} catch (journalError) {
							pushIssue({
								code: "block-journal-failed",
								message: `the block failure could not be recorded: ${messageOf(journalError)}`,
								stepIndex: index,
								routeStepId: step.id,
								block: step.definition.id,
							});
						}
					}
				}
				if (retries === 0 && isRetryable(step, caught)) {
					retries = 1;
					state = { events: [], journalIds: [], evidenceIds: [] };
					continue;
				}
				break;
			}
			if (!succeeded) break;
		} while (retries === 1 && error !== undefined && !succeeded);
		const durationMs = Math.max(0, (options.now ?? Date.now)() - stepStartedAt);
		if (succeeded) {
			lastPassingStep = step.id;
			if (outputs !== undefined) completedOutputs.set(step.id, outputs);
			results.push({
				index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				app: step.definition.app,
				...(step.definition.roles?.[0] === undefined
					? {}
					: { role: step.definition.roles[0] }),
				status: "passed",
				durationMs,
				retries,
				...(outputs === undefined ? {} : { outputs }),
				journalIds: [...state.journalIds],
				evidenceIds: [...state.evidenceIds],
			});
		} else {
			let evidence = state.evidenceIds;
			let observed: string | undefined;
			let captured: StageBlockFailureEvidence | undefined;
			if (options.failureEvidence !== undefined) {
				try {
					captured = await options.failureEvidence({
						step,
						context: host,
						error,
						...(lastPassingStep === undefined ? {} : { lastPassingStep }),
					});
					evidence = [...evidence, ...captured.evidenceIds];
					observed = captured.observed;
				} catch (captureError) {
					pushIssue({
						code: "block-failure-evidence",
						message: `failure evidence could not be captured: ${messageOf(captureError)}`,
						stepIndex: index,
						routeStepId: step.id,
						block: step.definition.id,
					});
				}
			}
			const message = messageOf(error);
			failure = {
				stepIndex: index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				message,
				retryable: isRetryable(step, error),
			};
			results.push({
				index,
				routeStepId: step.id,
				block: step.definition.id,
				version: step.definition.version,
				app: step.definition.app,
				...(step.definition.roles?.[0] === undefined
					? {}
					: { role: step.definition.roles[0] }),
				status: "failed",
				durationMs,
				retries,
				journalIds: [...state.journalIds],
				evidenceIds: [...evidence],
				error: observed === undefined ? message : `${message} (${observed})`,
			});
		}
		try {
			await host.close?.();
		} catch (closeError) {
			pushIssue({
				code: "block-context-close",
				message: `the block context could not be closed: ${messageOf(closeError)}`,
				stepIndex: index,
				routeStepId: step.id,
				block: step.definition.id,
			});
		}
	}
	return {
		planId: options.plan.planId,
		...(options.plan.flowId === undefined
			? {}
			: { flowId: options.plan.flowId }),
		...(options.plan.revision === undefined
			? {}
			: { revision: options.plan.revision }),
		inputsHash: options.plan.inputsHash,
		stage: options.stage,
		status: failure === undefined ? "passed" : "failed",
		steps: results,
		versions: options.plan.versions,
		durationMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
		...(failure === undefined ? {} : { failure }),
		...(issues.length === 0 ? {} : { issues }),
	};
}
