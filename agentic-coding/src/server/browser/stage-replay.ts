// The separate Playwright process of a compiled replay
// (`add-stage-flow-replay`, task 4). This module owns process setup, the
// bounded run directory, and decoding the process's own `stage-run.json`
// result contract; server-side ingestion (journal/evidence) and approval
// policy stay in the browser routes.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
	type ReplayEvent,
	type ReplayResult,
	replayResultSchema,
} from "../../contracts/stage-replay.ts";
import type { JsonValue } from "../../stage-blocks/schema.ts";
import { BrowserPoolError } from "./errors.ts";

export const REPLAY_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface ReplayProcessOptions {
	readonly root: string;
	readonly specPath: string;
	readonly flowId: string;
	readonly stage: string;
	readonly role?: string;
	readonly apps: Readonly<Record<string, string>>;
	readonly inputs: Readonly<Record<string, JsonValue>>;
	readonly planId?: string;
	readonly revision?: number;
	readonly routeHash: string;
	readonly inputsHash: string;
	readonly writeAllowed: boolean;
	readonly dataRoot: string;
	readonly executablePath?: string;
	readonly credentials?: Readonly<Record<string, string>>;
	readonly secretNames?: readonly string[];
	/** Secret-bearing variables that must not reach the child process. */
	readonly hiddenEnvNames?: readonly string[];
	readonly timeoutMs?: number;
}

export interface ReplayProcessResult {
	readonly runId: string;
	readonly runDir: string;
	readonly resultPath: string;
	readonly evidenceDir: string;
	readonly tracePath?: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

function configSource(
	options: ReplayProcessOptions,
	paths: {
		readonly resultPath: string;
		readonly evidenceDir: string;
		readonly outputDir: string;
		readonly jsonReport: string;
		readonly junitReport: string;
		readonly htmlReport: string;
	},
): string {
	// A plain object avoids resolving `@playwright/test` from the run directory,
	// which may sit outside the checkout that owns node_modules. The generated
	// spec still resolves its fixture import from the checkout.
	return `export default {
	testDir: ${JSON.stringify(path.dirname(options.specPath))},
	testMatch: "flow.spec.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 300_000,
	expect: { timeout: 15_000 },
	outputDir: ${JSON.stringify(paths.outputDir)},
	reporter: [
		["json", { outputFile: ${JSON.stringify(paths.jsonReport)} }],
		["junit", { outputFile: ${JSON.stringify(paths.junitReport)} }],
		["html", { outputDir: ${JSON.stringify(paths.htmlReport)}, open: "never" }],
		["line"],
	],
	use: {
		trace: "retain-on-failure",
		// Video needs Playwright's ffmpeg binary, which a minimal CI image or a
		// developer cache may not have. Trace still records every action; opt in
		// to video only on an image that installed it.
		video:
			process.env.STAGE_REPLAY_VIDEO === "1"
				? "retain-on-failure"
				: "off",
		screenshot: "only-on-failure",
		${options.executablePath === undefined ? "" : `launchOptions: { executablePath: ${JSON.stringify(options.executablePath)} },`}
	},
};
`;
}

function maxOutput(value: string): string {
	return value.length > 20_000
		? `${value.slice(0, 20_000)}\\n[truncated]`
		: value;
}

export async function runReplayProcess(
	options: ReplayProcessOptions,
): Promise<ReplayProcessResult> {
	const runId = `replay-${randomUUID()}`;
	const runDir = path.join(options.dataRoot, "stage-runs", runId);
	const evidenceDir = path.join(runDir, "evidence");
	const outputDir = path.join(runDir, "artifacts");
	const resultPath = path.join(runDir, "stage-run.json");
	const inputsPath = path.join(runDir, "inputs.json");
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.mkdirSync(outputDir, { recursive: true });
	fs.writeFileSync(inputsPath, `${JSON.stringify(options.inputs, null, 2)}\n`, {
		mode: 0o600,
	});
	const jsonReport = path.join(runDir, "playwright.json");
	const junitReport = path.join(runDir, "junit.xml");
	const htmlReport = path.join(runDir, "html");
	const configPath = path.join(runDir, "playwright.config.ts");
	fs.writeFileSync(
		configPath,
		configSource(options, {
			resultPath,
			evidenceDir,
			outputDir,
			jsonReport,
			junitReport,
			htmlReport,
		}),
		{ mode: 0o600 },
	);
	const localPlaywright = path.join(
		options.root,
		"node_modules",
		".bin",
		"playwright",
	);
	const command = fs.existsSync(localPlaywright)
		? [localPlaywright, "test", `--config=${configPath}`]
		: ["bunx", "playwright", "test", `--config=${configPath}`];
	const env: Record<string, string> = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!(options.hiddenEnvNames ?? []).includes(entry[0]),
		),
	);
	Object.assign(env, options.credentials, {
		STAGE_FLOW_MANIFEST: path.join(path.dirname(options.specPath), "flow.json"),
		STAGE_FLOW_INPUTS_FILE: inputsPath,
		STAGE_RUN_RESULT: resultPath,
		STAGE_EVIDENCE_DIR: evidenceDir,
		STAGE_APP_URLS: JSON.stringify(options.apps),
		STAGE_STAGE: options.stage,
		STAGE_RUN_ID: runId,
		STAGE_ROUTE_HASH: options.routeHash,
		STAGE_INPUTS_HASH: options.inputsHash,
		STAGE_WRITE_ALLOWED: options.writeAllowed ? "1" : "0",
		STAGE_SECRET_NAMES: (options.secretNames ?? []).join(","),
		...(options.role === undefined ? {} : { STAGE_ROLE: options.role }),
		...(options.planId === undefined ? {} : { STAGE_PLAN_ID: options.planId }),
		...(options.revision === undefined
			? {}
			: { STAGE_PLAN_REVISION: String(options.revision) }),
	});
	const child = Bun.spawn(command, {
		cwd: options.root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeoutMs = options.timeoutMs ?? REPLAY_DEFAULT_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	clearTimeout(timer);
	let tracePath: string | undefined;
	try {
		const artifacts = fs.readdirSync(outputDir, {
			recursive: true,
			encoding: "utf8",
		});
		tracePath = artifacts
			.map((entry) => path.join(outputDir, entry))
			.find((entry) => entry.endsWith("trace.zip"));
	} catch {
		// A crashed process may leave no artifacts.
	}
	return {
		runId,
		runDir,
		resultPath,
		evidenceDir,
		...(tracePath === undefined ? {} : { tracePath }),
		stdout: maxOutput(stdout),
		stderr: maxOutput(stderr),
		exitCode,
		timedOut,
	};
}

/** Decodes and cross-checks one replay process's `stage-run.json` against the
 * identity the caller launched it for. The route and `scripts/stage-flow-run.ts`
 * (no server, no workflow) share this one check, so a malformed result, an
 * identity mismatch or a non-zero exit reporting a pass is refused identically
 * whether the agent or CI ran the process. */
export function decodeReplayResult(
	resultPath: string,
	identity: {
		readonly flowId: string;
		readonly routeHash: string;
		readonly inputsHash: string;
	},
	exitCode: number | null,
	redact: (text: string) => string = (text) => text,
	processOutput: { readonly stdout: string; readonly stderr: string } = {
		stdout: "",
		stderr: "",
	},
): ReplayResult {
	if (!fs.existsSync(resultPath))
		throw new BrowserPoolError(
			"replay-result-invalid",
			redact(
				`the replay process exited ${exitCode} without stage-run.json: ${processOutput.stderr.slice(0, 1_000) || processOutput.stdout.slice(0, 1_000)}`,
			),
			502,
		);
	let result: ReplayResult;
	try {
		result = Schema.decodeUnknownSync(replayResultSchema)(
			JSON.parse(fs.readFileSync(resultPath, "utf8")),
		) as ReplayResult;
	} catch (error) {
		throw new BrowserPoolError(
			"replay-result-invalid",
			redact(
				`stage-run.json does not match the replay contract: ${error instanceof Error ? error.message : String(error)}`,
			),
			502,
		);
	}
	if (
		result.flowId !== identity.flowId ||
		result.routeHash !== identity.routeHash ||
		result.inputsHash !== identity.inputsHash
	)
		throw new BrowserPoolError(
			"replay-result-invalid",
			"stage-run.json identity does not match the approved flow, route or inputs",
			502,
		);
	if (exitCode !== 0 && result.status === "passed")
		throw new BrowserPoolError(
			"replay-result-invalid",
			`the replay process exited ${exitCode} but reported a pass`,
			502,
		);
	return result;
}

/** A result from a fixture too old to emit the richer `events` carries only
 * `steps`; this derives one ingestible event per step so ingestion has a
 * single input shape either way. A `skipped` step (never attempted after an
 * earlier failure, or a future runner's own partial-skip semantics) becomes a
 * `failed` event — a step this run never verified is not evidence of a pass,
 * so it is ingested as the refusal it actually represents. */
export function replayEventsFromSteps(
	result: Pick<ReplayResult, "events" | "steps">,
): readonly ReplayEvent[] {
	if (result.events !== undefined && result.events.length > 0)
		return result.events;
	return result.steps.map((step) => ({
		index: step.index,
		routeStepId: step.routeStepId,
		block: step.block,
		version: step.version,
		subStep: step.block,
		status: step.status === "skipped" ? ("failed" as const) : step.status,
		durationMs: step.durationMs,
		...(step.error === undefined ? {} : { error: step.error }),
		evidence: step.evidence ?? [],
	}));
}
