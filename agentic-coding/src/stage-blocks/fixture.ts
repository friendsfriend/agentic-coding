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
import type {
	BlockAssertion,
	BlockDefinition,
	BlockLocator,
	BlockPage,
	StageApiClient,
	StageApiResponse,
	StageContext,
} from "./define-block.ts";
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
}

const PLAYWRIGHT_LOCATOR = Symbol("stage.playwright-locator");

type AdaptedLocator = BlockLocator & { readonly [PLAYWRIGHT_LOCATOR]: Locator };

function locatorAdapter(locator: Locator): AdaptedLocator {
	return {
		[PLAYWRIGHT_LOCATOR]: locator,
		click: () => locator.click(),
		fill: (value) => locator.fill(value),
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

function pageAdapter(page: Page): BlockPage {
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

function manifestFor(testInfo: TestInfo): FlowManifest {
	const configured = process.env.STAGE_FLOW_MANIFEST;
	const file =
		configured === undefined || configured === ""
			? path.join(path.dirname(testInfo.file), "flow.json")
			: path.resolve(configured);
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
		const stage: StageRehearsal = {
			input<T = JsonValue>(name: string): T {
				if (!Object.hasOwn(inputs, name))
					throw new Error(`flow input ${name} is not declared`);
				return inputs[name] as T;
			},
			async run(routeStepId, block, args) {
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
										error:
											error instanceof Error ? error.message : String(error),
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
			},
		};
		await use(stage);
		const durationMs = Date.now() - start;
		const failed = events.find((event) => event.status === "failed");
		writeResult(testInfo, {
			version: 1,
			flowId: manifest.flowId,
			planId: manifest.generatedFrom.planId,
			...(manifest.generatedFrom.revision === undefined
				? {}
				: { revision: manifest.generatedFrom.revision }),
			stage: manifest.stage,
			routeHash: manifest.routeHash,
			inputsHash,
			status: failed === undefined ? "passed" : "failed",
			startedAt: startedAt.toISOString(),
			durationMs,
			steps: stepResults,
			events,
			...(failed?.error === undefined ? {} : { error: failed.error }),
		});
	},
});

export { expect } from "@playwright/test";
