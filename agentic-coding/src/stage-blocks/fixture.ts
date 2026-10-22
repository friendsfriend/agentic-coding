// The standalone rehearsal fixture (`add-stage-flow-replay`). A generated spec
// imports this instead of `@playwright/test` directly: the blocks, the input
// values and the event journal are the same contract `stage_run` uses, but no
// model, server session or workflow run sits in the loop.
//
// The fixture is deliberately a thin adapter. Policy stays in the server; this
// path is for an already approved flow whose values arrive from CI.

import fs from "node:fs";
import path from "node:path";
import {
	type APIRequestContext,
	test as base,
	type Locator,
	type Page,
	expect as playwrightExpect,
	type TestInfo,
} from "@playwright/test";
import {
	MAX_API_RESPONSE_BYTES,
	MAX_STAGE_API_REQUEST_BYTES,
} from "../contracts/stages.ts";
import { compileDataBlock, validateDataBlock } from "./data-block.ts";
import type {
	BlockAssertion,
	BlockDefinition,
	BlockLocator,
	BlockPage,
	StageApiClient,
	StageApiResponse,
	StageContext,
} from "./define-block.ts";
import { blockDigest } from "./define-block.ts";
import type { FlowManifest } from "./flow.ts";
import { canonicalInputsHash, parseFlowManifest } from "./flow.ts";
import type { JsonValue } from "./schema.ts";
import { validateSchemaValue } from "./schema.ts";

export interface RehearsalEvent {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly url?: string;
	readonly subStep: string;
	readonly status: "passed" | "failed";
	readonly durationMs: number;
	readonly error?: string;
	readonly evidence: readonly string[];
	readonly captures?: Readonly<Record<string, string>>;
	readonly knowledge?: unknown;
}

export interface RehearsalStepResult {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly app?: string;
	readonly status: "passed" | "failed" | "skipped";
	readonly durationMs: number;
	readonly outputs?: Readonly<Record<string, JsonValue>>;
	readonly evidence?: readonly string[];
	readonly error?: string;
}

export interface RehearsalResult {
	readonly version: 1;
	readonly flowId: string;
	readonly planId?: string;
	readonly revision?: number;
	readonly stage: string;
	readonly routeHash: string;
	readonly inputsHash: string;
	readonly status: "passed" | "failed";
	readonly startedAt: string;
	readonly durationMs: number;
	readonly steps: readonly RehearsalStepResult[];
	readonly events: readonly RehearsalEvent[];
	readonly error?: string;
}

export interface StageRehearsal {
	input<T = JsonValue>(name: string): T;
	run<
		Args extends Record<string, JsonValue>,
		Outputs extends Record<string, JsonValue>,
	>(
		routeStepId: string,
		block: BlockDefinition<Args, Outputs>,
		args: Args,
	): Promise<Outputs>;
	/** Run one route step whose block is a reviewed data document: the fixture
	 * loads the flow's own sidecar copy, so no barrel import exists. */
	runData(
		routeStepId: string,
		args: Readonly<Record<string, JsonValue>>,
	): Promise<Record<string, JsonValue>>;
}

const PLAYWRIGHT_LOCATOR = Symbol("stage.playwright-locator");

type AdaptedLocator = BlockLocator & { readonly [PLAYWRIGHT_LOCATOR]: Locator };

function locatorAdapter(locator: Locator): AdaptedLocator {
	return {
		[PLAYWRIGHT_LOCATOR]: locator,
		click: () => locator.click(),
		fill: (value) => locator.fill(value),
		type: (value, options) =>
			locator.pressSequentially(
				value,
				options?.delayMs === undefined ? {} : { delay: options.delayMs },
			),
		press: (key) => locator.press(key),
		selectOption: async (values) => {
			await locator.selectOption(values);
		},
		textContent: () => locator.textContent(),
		innerText: () => locator.innerText(),
		isVisible: () => locator.isVisible(),
		waitFor: (options) => locator.waitFor(options),
	};
}

/** The route step that was running when the test ended, if any. */
export interface OpenRoute {
	readonly index: number;
	readonly routeStepId: string;
	readonly block: string;
	readonly version: string;
	readonly subStep?: string;
}

/** The event a replay writes when the test ended without a recorded failure.
 * A Playwright timeout *between* sub-steps — the fixture is disposed before any
 * `ctx.step` catch runs — would otherwise be reported as a pass. */
export function unrecordedFailure(
	status: string | undefined,
	open: OpenRoute | undefined,
	durationMs: number,
): RehearsalEvent | undefined {
	// No verdict yet (a fixture that never reached `use`) or a pass: nothing to
	// synthesise. A non-zero exit with a reported pass is caught again by the
	// replay process, so an unknown status never silently claims success there.
	if (status === undefined || status === "passed") return undefined;
	const where =
		open === undefined
			? "before any route step started"
			: `${open.routeStepId} (${open.block}@${open.version})${open.subStep === undefined ? "" : ` at ${open.subStep}`}`;
	const reason = `the replay ${status === "timedOut" ? "timed out" : `ended as ${status}`} without a recorded failure at ${where}`;
	return {
		index: open?.index ?? 0,
		routeStepId: open?.routeStepId ?? "(none)",
		block: open?.block ?? "(none)",
		version: open?.version ?? "0.0.0",
		subStep: open?.subStep ?? "(none)",
		status: "failed",
		durationMs,
		error: reason,
		evidence: [],
	};
}

/** The result document a replay writes, assembled from what the fixture recorded.
 * Pure and exported as a test seam: the failure synthesis below is exactly the
 * half that decides whether a broken replay claims a pass (`TQV-006`). */
export function rehearsalOutcome(input: {
	readonly manifest: FlowManifest;
	readonly inputsHash: string;
	readonly startedAt: string;
	readonly durationMs: number;
	/** Playwright's own verdict for the run (`testInfo.status`). */
	readonly status: string | undefined;
	readonly events: readonly RehearsalEvent[];
	readonly steps: readonly RehearsalStepResult[];
	readonly openRoute?: OpenRoute;
}): RehearsalResult {
	const events = [...input.events];
	const stepResults = [...input.steps];
	// A block is the unit of failure, not a sub-step event: a data block may
	// swallow a failed event inside an `optional` group and still pass, and the
	// events of that group must not fail the replay (`QUALITY-001`).
	let failedStep = stepResults.find((step) => step.status === "failed");
	// A test that ended without a failed block — a Playwright timeout between
	// sub-steps is the common case — must not be reported as a pass. Name the
	// step it stopped in and write it as the failure.
	if (failedStep === undefined) {
		const synthesised = unrecordedFailure(
			input.status,
			input.openRoute,
			input.durationMs,
		);
		if (synthesised !== undefined) {
			const reason =
				synthesised.error ?? "the replay ended without a recorded failure";
			events.push(synthesised);
			const openRoute = input.openRoute;
			if (
				openRoute !== undefined &&
				!stepResults.some((step) => step.routeStepId === openRoute.routeStepId)
			) {
				const added: RehearsalStepResult = {
					index: openRoute.index,
					routeStepId: openRoute.routeStepId,
					block: openRoute.block,
					version: openRoute.version,
					app: "(none)",
					status: "failed",
					durationMs: input.durationMs,
					evidence: [],
					error: reason,
				};
				stepResults.push(added);
				failedStep = added;
			}
		}
	}
	const failed =
		failedStep === undefined
			? undefined
			: (events
					.filter(
						(event) =>
							event.routeStepId === failedStep?.routeStepId &&
							event.status === "failed",
					)
					.at(-1) ??
				(failedStep.error === undefined
					? undefined
					: {
							index: failedStep.index,
							routeStepId: failedStep.routeStepId,
							status: "failed" as const,
							error: failedStep.error,
						}));
	const failedReason = failedStep?.error ?? failed?.error;
	return {
		version: 1,
		flowId: input.manifest.flowId,
		planId: input.manifest.generatedFrom.planId,
		...(input.manifest.generatedFrom.revision === undefined
			? {}
			: { revision: input.manifest.generatedFrom.revision }),
		stage: input.manifest.stage,
		routeHash: input.manifest.routeHash,
		inputsHash: input.inputsHash,
		status: failedStep === undefined ? "passed" : "failed",
		startedAt: input.startedAt,
		durationMs: input.durationMs,
		steps: stepResults,
		events,
		...(failedReason === undefined ? {} : { error: failedReason }),
	};
}

/** The allow-listed page facade over a Playwright page. Exported as a test seam:
 * `type` has to reach `pressSequentially` (a real key-by-key typing) rather than
 * `fill`, which is what a `type` operation means. */
export function pageAdapter(page: Page): BlockPage {
	return {
		goto: async (url) => {
			await page.goto(url);
		},
		url: () => page.url(),
		title: () => page.title(),
		getByRole: (role, options) =>
			locatorAdapter(
				page.getByRole(role as Parameters<Page["getByRole"]>[0], options),
			),
		getByLabel: (label) => locatorAdapter(page.getByLabel(label)),
		getByTestId: (testId) => locatorAdapter(page.getByTestId(testId)),
		getByText: (text, options) => locatorAdapter(page.getByText(text, options)),
		locator: (selector) => locatorAdapter(page.locator(selector)),
		reload: async () => {
			await page.reload();
		},
		waitForTimeout: async (ms) => {
			await page.waitForTimeout(ms);
		},
	};
}

function assert(locator: BlockLocator): BlockAssertion {
	const playwrightLocator = (locator as Partial<AdaptedLocator>)[
		PLAYWRIGHT_LOCATOR
	];
	if (playwrightLocator === undefined)
		throw new Error("assertions require a locator from this page adapter");
	return {
		toContainText: async (expected) => {
			await playwrightExpect(playwrightLocator).toContainText(expected);
		},
		toBeVisible: async () => {
			await playwrightExpect(playwrightLocator).toBeVisible();
		},
	};
}

function readJsonFile<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function manifestFilePath(testInfo: TestInfo): string {
	const configured = process.env.STAGE_FLOW_MANIFEST;
	return configured === undefined || configured === ""
		? path.join(path.dirname(testInfo.file), "flow.json")
		: path.resolve(configured);
}

function manifestFor(testInfo: TestInfo): FlowManifest {
	const file = manifestFilePath(testInfo);
	const parsed = parseFlowManifest(readJsonFile<unknown>(file));
	if (parsed.manifest === undefined || parsed.issues.length > 0)
		throw new Error(
			`${file} is not a valid flow manifest: ${parsed.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	return parsed.manifest;
}

function valuesFor(manifest: FlowManifest): Record<string, JsonValue> {
	const inline = process.env.STAGE_FLOW_INPUTS;
	const file = process.env.STAGE_FLOW_INPUTS_FILE;
	const values =
		inline !== undefined && inline !== ""
			? (JSON.parse(inline) as JsonValue)
			: file !== undefined && file !== ""
				? readJsonFile<JsonValue>(path.resolve(file))
				: (manifest.inputExamples[0] ?? {});
	if (values === null || typeof values !== "object" || Array.isArray(values))
		throw new Error("STAGE_FLOW_INPUTS must be a JSON object");
	const problems = validateSchemaValue(manifest.inputSchema, values, "inputs");
	if (problems.length > 0)
		throw new Error(
			`replay inputs do not match the flow schema: ${problems
				.map((problem) => `${problem.path} ${problem.message}`)
				.join("; ")}`,
		);
	return values as Record<string, JsonValue>;
}

function appUrls(): Record<string, string> {
	const inline = process.env.STAGE_APP_URLS;
	if (inline !== undefined && inline !== "") {
		const parsed = JSON.parse(inline) as Record<string, string>;
		return parsed;
	}
	const single = process.env.STAGE_APP_URL;
	return single === undefined || single === "" ? {} : { "*": single };
}

function urlFor(app: string): string {
	const urls = appUrls();
	const url = urls[app] ?? urls["*"];
	if (url === undefined || url === "")
		throw new Error(
			`no URL for application ${app}; set STAGE_APP_URLS or STAGE_APP_URL`,
		);
	return url.replace(/\/+$/, "");
}

export function apiClient(
	request: APIRequestContext,
	role: string,
	manifest: FlowManifest,
): StageApiClient {
	const token = process.env.STAGE_API_TOKEN;
	const urls = appUrls();
	const writeAllowed = process.env.STAGE_WRITE_ALLOWED === "1";
	return {
		async request(input): Promise<StageApiResponse> {
			// Each call declares its own role (D6: a flow's setup, assertion and
			// cleanup calls may legitimately use different declared roles, decoupled
			// from the single browser-session role). `role` above is only the
			// fallback for a call that omits one; the declared-role check always
			// runs against whichever role the call actually used.
			const calledRole = input.role.trim() === "" ? role : input.role;
			if (calledRole.trim() === "")
				throw new Error(
					"a stage API call needs a declared role; none was resolved for this replay",
				);
			if (!manifest.roles.includes(calledRole))
				throw new Error(
					`role ${calledRole} is not declared by flow ${manifest.flowId}`,
				);
			if (!input.path.startsWith("/") || input.path.includes(".."))
				throw new Error("a stage API path must be relative and contain no ..");
			if (!manifest.applications.includes(input.app))
				throw new Error(
					`application ${input.app} is not declared by flow ${manifest.flowId}`,
				);
			const method = input.method.toUpperCase();
			if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
				throw new Error(`stage API method ${input.method} is not allowed`);
			if (!writeAllowed && method !== "GET" && method !== "HEAD")
				throw new Error(
					`stage API ${method} ${input.path} is a write on a read-only replay`,
				);
			const base = urls[input.app] ?? urls["*"];
			if (base === undefined)
				throw new Error(`no API URL for application ${input.app}`);
			const bodyText =
				input.body === undefined ? undefined : JSON.stringify(input.body);
			if (
				bodyText !== undefined &&
				Buffer.byteLength(bodyText, "utf8") > MAX_STAGE_API_REQUEST_BYTES
			)
				throw new Error(
					`stage API ${method} ${input.path} body is larger than ${MAX_STAGE_API_REQUEST_BYTES} bytes`,
				);
			const response = await request.fetch(
				`${base.replace(/\/+$/, "")}${input.path}`,
				{
					method,
					headers: {
						...(token === undefined || token === ""
							? {}
							: { authorization: `Bearer ${token}` }),
						"x-stage-app": input.app,
						"x-stage-role": calledRole,
					},
					...(input.body === undefined ? {} : { data: input.body }),
				},
			);
			// Read at most the response bound, then stop: the same cap
			// `stage_api_request` reads through, so a misconfigured endpoint cannot
			// stream an unbounded body into this process either.
			const rawBody = await response.body();
			const bounded = rawBody.subarray(0, MAX_API_RESPONSE_BYTES);
			let body: JsonValue = null;
			try {
				body = JSON.parse(bounded.toString("utf8")) as JsonValue;
			} catch {
				body = null;
			}
			return { status: response.status(), headers: response.headers(), body };
		},
	};
}

function resultPath(testInfo: TestInfo): string {
	const configured = process.env.STAGE_RUN_RESULT;
	return configured === undefined || configured === ""
		? testInfo.outputPath("stage-run.json")
		: path.resolve(configured);
}

function evidenceDir(testInfo: TestInfo): string {
	const configured = process.env.STAGE_EVIDENCE_DIR;
	return configured === undefined || configured === ""
		? testInfo.outputPath("evidence")
		: path.resolve(configured);
}

function writeResult(testInfo: TestInfo, result: RehearsalResult): void {
	const file = resultPath(testInfo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, {
		mode: 0o600,
	});
}

export const test = base.extend<{ stage: StageRehearsal }>({
	stage: async ({ page, request }, use, testInfo) => {
		const manifest = manifestFor(testInfo);
		const expectedStage = process.env.STAGE_STAGE;
		if (
			expectedStage !== undefined &&
			expectedStage !== "" &&
			manifest.stage !== expectedStage
		)
			throw new Error(
				`flow ${manifest.flowId} is saved for ${manifest.stage}, not ${expectedStage}`,
			);
		const expectedRoute = process.env.STAGE_ROUTE_HASH;
		if (
			expectedRoute !== undefined &&
			expectedRoute !== "" &&
			manifest.routeHash !== expectedRoute
		)
			throw new Error(
				`flow ${manifest.flowId} route ${manifest.routeHash} does not match ${expectedRoute}`,
			);
		const inputs = valuesFor(manifest);
		const inputsHash = canonicalInputsHash(inputs);
		const expectedInputs = process.env.STAGE_INPUTS_HASH;
		if (
			expectedInputs !== undefined &&
			expectedInputs !== "" &&
			inputsHash !== expectedInputs
		)
			throw new Error(
				`replay inputs hash ${inputsHash} does not match ${expectedInputs}`,
			);
		const role = process.env.STAGE_ROLE ?? manifest.roles[0] ?? "";
		const events: RehearsalEvent[] = [];
		const stepResults: RehearsalStepResult[] = [];
		const secretNames = new Set(
			(process.env.STAGE_SECRET_NAMES ?? "")
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name !== ""),
		);
		let captureCount = 0;
		const startedAt = new Date();
		const start = Date.now();
		// The route step that is currently running, so a test that ends without a
		// recorded failure (a Playwright timeout between sub-steps) can still name
		// the step it died on instead of claiming a pass.
		let openRoute: OpenRoute | undefined;
		let openStep:
			| {
					routeStepId: string;
					block: string;
					version: string;
					subStep: string;
					started: number;
					evidence: string[];
			  }
			| undefined;
		const execute = async <
			Args extends Record<string, JsonValue>,
			Outputs extends Record<string, JsonValue>,
		>(
			routeStepId: string,
			block: BlockDefinition<Args, Outputs>,
			args: Args,
		): Promise<Outputs> => {
			const routeIndex = manifest.routeSteps.findIndex(
				(step) => step.routeStepId === routeStepId,
			);
			const route = manifest.routeSteps[routeIndex];
			if (route === undefined)
				throw new Error(`route step ${routeStepId} is not in the manifest`);
			if (block.id !== route.block)
				throw new Error(
					`route step ${routeStepId} is ${route.block}, not ${block.id}`,
				);
			if (block.version !== manifest.blockVersions[block.id])
				throw new Error(
					`block ${block.id}@${block.version} drifted from ${manifest.blockVersions[block.id]}`,
				);
			const appUrl = urlFor(
				block.app === "*" ? (manifest.applications[0] ?? "*") : block.app,
			);
			const stepEvidence: string[] = [];
			const stepStarted = Date.now();
			openRoute = {
				index: routeIndex,
				routeStepId,
				block: block.id,
				version: block.version,
			};
			const context: StageContext = {
				page: pageAdapter(page),
				expect: assert,
				app: block.app === "*" ? (manifest.applications[0] ?? "") : block.app,
				...(role === "" ? {} : { role }),
				stage: manifest.stage,
				appUrl,
				run: {
					planId: manifest.generatedFrom.planId,
					...(manifest.generatedFrom.revision === undefined
						? {}
						: { revision: manifest.generatedFrom.revision }),
					flowId: manifest.flowId,
					routeStepId,
					blockId: block.id,
					blockVersion: block.version,
					index: routeIndex,
				},
				api: apiClient(request, role, manifest),
				step: async (label, fn, details) => {
					openStep = {
						routeStepId,
						block: block.id,
						version: block.version,
						subStep: label,
						started: Date.now(),
						evidence: [],
					};
					openRoute = {
						index: routeIndex,
						routeStepId,
						block: block.id,
						version: block.version,
						subStep: label,
					};
					const stepStart = Date.now();
					try {
						return await test.step(label, async () => {
							try {
								const value = await fn();
								const detail =
									typeof details === "function" ? details() : details;
								events.push({
									index: routeIndex,
									routeStepId,
									block: block.id,
									version: block.version,
									url: page.url(),
									subStep: label,
									status: "passed",
									durationMs: Date.now() - stepStart,
									evidence: [...(openStep?.evidence ?? [])],
									...(detail?.captures === undefined
										? {}
										: { captures: detail.captures }),
									...(detail?.knowledge === undefined
										? {}
										: { knowledge: detail.knowledge }),
								});
								return value;
							} catch (error) {
								events.push({
									index: routeIndex,
									routeStepId,
									block: block.id,
									version: block.version,
									subStep: label,
									status: "failed",
									durationMs: Date.now() - stepStart,
									error: error instanceof Error ? error.message : String(error),
									evidence: [...(openStep?.evidence ?? [])],
								});
								throw error;
							}
						});
					} finally {
						openStep = undefined;
					}
				},
				capture: async (label) => {
					if (openStep === undefined)
						throw new Error(
							`capture "${label}" must happen inside a ctx.step sub-step`,
						);
					const dir = evidenceDir(testInfo);
					fs.mkdirSync(dir, { recursive: true });
					captureCount += 1;
					const file = path.join(
						dir,
						`${String(captureCount).padStart(3, "0")}-${label.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60)}.jpg`,
					);
					await page.screenshot({ path: file, type: "jpeg" });
					const id = path.basename(file);
					openStep.evidence.push(id);
					stepEvidence.push(id);
					return id;
				},
				secret: (name) => {
					if (!/^[A-Z][A-Z0-9_]*$/.test(name))
						throw new Error(`secret name ${name} is not an environment name`);
					if (!secretNames.has(name))
						throw new Error(
							`secret ${name} is not a declared stage credential of this replay`,
						);
					const value = process.env[name];
					if (value === undefined || value === "")
						throw new Error(`secret ${name} is not configured`);
					return value;
				},
			};
			try {
				const outputs = await block.run(context, args);
				stepResults.push({
					index: routeIndex,
					routeStepId,
					block: block.id,
					version: block.version,
					app: block.app,
					status: "passed",
					durationMs: Date.now() - stepStarted,
					outputs,
					evidence: [...stepEvidence],
				});
				return outputs;
			} catch (error) {
				if (testInfo.status === "passed") testInfo.status = "failed";
				stepResults.push({
					index: routeIndex,
					routeStepId,
					block: block.id,
					version: block.version,
					app: block.app,
					status: "failed",
					durationMs: Date.now() - stepStarted,
					evidence: [...stepEvidence],
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		};
		const stage: StageRehearsal = {
			input<T = JsonValue>(name: string): T {
				if (!Object.hasOwn(inputs, name))
					throw new Error(`flow input ${name} is not declared`);
				return inputs[name] as T;
			},
			async run<
				Args extends Record<string, JsonValue>,
				Outputs extends Record<string, JsonValue>,
			>(
				routeStepId: string,
				block: BlockDefinition<Args, Outputs>,
				args: Args,
			) {
				return (await execute(routeStepId, block, args)) as Outputs;
			},
			async runData(routeStepId, args) {
				const pinned = pinnedDataBlock({
					manifest,
					directory: path.dirname(manifestFilePath(testInfo)),
					routeStepId,
				});
				return await execute(routeStepId, pinned, args);
			},
		};
		await use(stage);
		writeResult(
			testInfo,
			rehearsalOutcome({
				manifest,
				inputsHash,
				startedAt: startedAt.toISOString(),
				durationMs: Date.now() - start,
				status: testInfo.status,
				events,
				steps: stepResults,
				...(openRoute === undefined ? {} : { openRoute }),
			}),
		);
	},
});

/** The document a compiled flow pinned for one route step.
 *
 * A data block has no TypeScript export and no barrel entry, so the replay has
 * to carry the reviewed JSON beside the spec: the manifest names the sidecar
 * (`blockFiles`) and pins its digest (`blockDigests`). This is the whole
 * substitution rule in one place, exported as a test seam because it is the
 * step a replay dies on — a wrong path, a different document or a skipped
 * execution must fail *here*, naming the route step, instead of surfacing as an
 * unexplained replay failure against a hosted stage (`TQV-101`). */
export function pinnedDataBlock(input: {
	readonly manifest: FlowManifest;
	readonly directory: string;
	readonly routeStepId: string;
}): BlockDefinition<Record<string, JsonValue>, Record<string, JsonValue>> {
	const { manifest, routeStepId } = input;
	const route = manifest.routeSteps.find(
		(step) => step.routeStepId === routeStepId,
	);
	if (route === undefined)
		throw new Error(`route step ${routeStepId} is not in the manifest`);
	const recorded = manifest.blockFiles?.[route.block];
	if (recorded === undefined)
		throw new Error(
			`flow ${manifest.flowId} records no reviewed document for ${route.block}; re-save the flow`,
		);
	const file = path.join(input.directory, recorded);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	} catch (error) {
		throw new Error(
			`data block ${route.block} has no sidecar at ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const validation = validateDataBlock(value);
	if (!validation.ok || validation.document === undefined)
		throw new Error(
			`data block ${route.block} is invalid: ${validation.issues
				.map((issue) => `${issue.path} ${issue.message}`)
				.join("; ")}`,
		);
	const compiled = compileDataBlock(validation.document);
	// The replay executes exactly the document the manifest pinned: a sidecar
	// edited after the flow was saved is a different block, not a silent
	// substitution (`OSV-009`).
	const expectedDigest = manifest.blockDigests[route.block];
	const actualDigest = blockDigest(compiled);
	if (expectedDigest !== undefined && expectedDigest !== actualDigest)
		throw new Error(
			`data block ${route.block}@${compiled.version} no longer matches the digest flow ${manifest.flowId} pinned at ${routeStepId}`,
		);
	return compiled as BlockDefinition<
		Record<string, JsonValue>,
		Record<string, JsonValue>
	>;
}

export { expect } from "@playwright/test";
