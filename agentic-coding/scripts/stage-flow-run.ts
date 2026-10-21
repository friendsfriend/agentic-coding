#!/usr/bin/env bun
// Standalone CI runner for a compiled stage flow or suite
// (`add-stage-flow-replay`, design D7/D8, tasks 10.1-10.3). This is the
// "standalone CI suite" path the design separates from `stage_replay`: it
// never opens a workflow, never claims a `core.stage-test-plan` approval and
// never writes to a workflow's evidence/journal store. It reuses the same
// generated spec, the same `runReplayProcess` launcher, the same result
// contract and the same suite orchestration (`runSuiteEntries`) the HTTP
// route uses, so a flow behaves identically whether a developer, the agent or
// CI runs it — only the "approved plan" gate is specific to the agent path.
//
// Usage:
//   bun run scripts/stage-flow-run.ts --flow customer-address \
//     --stage crm-stage --inputs inputs.json [--config-dir <dir>] [--root <dir>]
//   bun run scripts/stage-flow-run.ts --suite crm-smoke --stage crm-stage
//
// Exits non-zero on a schema error, a non-zero process exit, an invalid
// result or any failed/refused entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigRoot } from "../src/config-root.ts";
import { BrowserPoolError } from "../src/server/browser/errors.ts";
import {
	decodeReplayResult,
	REPLAY_DEFAULT_TIMEOUT_MS,
	runReplayProcess,
} from "../src/server/browser/stage-replay.ts";
import {
	environmentSecrets,
	redact,
} from "../src/server/environment/secrets.ts";
import {
	readStageCatalog,
	stageCredentialVariables,
} from "../src/server/stages/catalog.ts";
import { canonicalInputsHash } from "../src/stage-blocks/flow.ts";
import { readFlowRegistry } from "../src/stage-blocks/flow-registry.ts";
import type { JsonValue } from "../src/stage-blocks/schema.ts";
import { validateSchemaValue } from "../src/stage-blocks/schema.ts";
import {
	readSuiteRegistry,
	runSuiteEntries,
	type SuiteEntryResult,
	type SuiteFlowEntry,
	type SuiteManifest,
} from "../src/stage-blocks/suite.ts";

interface CliOptions {
	readonly root: string;
	readonly configDir: string;
	readonly stage?: string;
	readonly flowId?: string;
	readonly suiteId?: string;
	readonly inputsFile?: string;
	readonly executablePath?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
	const options: {
		root: string;
		configDir: string;
		stage?: string;
		flowId?: string;
		suiteId?: string;
		inputsFile?: string;
		executablePath?: string;
	} = {
		root: process.cwd(),
		configDir: resolveConfigRoot(),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--root" && value !== undefined) {
			options.root = path.resolve(value);
			index += 1;
		} else if (flag === "--config-dir" && value !== undefined) {
			options.configDir = path.resolve(value);
			index += 1;
		} else if (flag === "--stage" && value !== undefined) {
			options.stage = value;
			index += 1;
		} else if (flag === "--flow" && value !== undefined) {
			options.flowId = value;
			index += 1;
		} else if (flag === "--suite" && value !== undefined) {
			options.suiteId = value;
			index += 1;
		} else if (flag === "--inputs" && value !== undefined) {
			options.inputsFile = value;
			index += 1;
		} else if (flag === "--executable-path" && value !== undefined) {
			options.executablePath = value;
			index += 1;
		}
	}
	return options;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

async function runOneFlow(
	options: CliOptions,
	flowId: string,
	stage: string,
	inputs: Readonly<Record<string, JsonValue>>,
): Promise<SuiteEntryResult & { readonly resultPath?: string }> {
	const registry = readFlowRegistry(options.root);
	const entry = registry.entries.find(
		(candidate) => candidate.manifest.flowId === flowId,
	);
	if (entry === undefined)
		return {
			id: flowId,
			flowId,
			status: "refused",
			code: "flow-not-found",
			error: `flow ${flowId} is not saved under stage-flows`,
		};
	const schemaIssues = validateSchemaValue(
		entry.manifest.inputSchema,
		inputs,
		"inputs",
	);
	if (schemaIssues.length > 0)
		return {
			id: flowId,
			flowId,
			status: "refused",
			code: "flow-inputs-invalid",
			error: schemaIssues.map((issue) => issue.message).join("; "),
		};
	const catalog = readStageCatalog(options.configDir);
	const stageEntry = catalog.entries.find(
		(candidate) => candidate.ident === stage,
	);
	if (stageEntry === undefined)
		return {
			id: flowId,
			flowId,
			status: "refused",
			code: "stage-not-configured",
			error: `stage ${stage} is not configured`,
		};
	const appUrls = Object.fromEntries(
		Object.entries(stageEntry.stage.apps).map(([key, app]) => [key, app.url]),
	);
	const stageVariables = [...stageCredentialVariables(catalog).entries()]
		.filter(([, value]) => value.stage === stage)
		.map(([name]) => name);
	const configuredSecrets = environmentSecrets(options.configDir);
	const availableSecrets = new Map(
		configuredSecrets.map((secret) => [secret.name, secret.value]),
	);
	const credentials = Object.fromEntries(
		stageVariables
			.filter((name) => availableSecrets.has(name))
			.map((name) => [name, availableSecrets.get(name) as string]),
	);
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage-flow-ci-"));
	const processResult = await runReplayProcess({
		root: options.root,
		specPath: entry.specPath,
		flowId,
		stage,
		apps: appUrls,
		inputs,
		routeHash: entry.manifest.routeHash,
		inputsHash: canonicalInputsHash(inputs),
		writeAllowed: stageEntry.stage.access === "writable",
		dataRoot,
		credentials,
		secretNames: stageVariables,
		hiddenEnvNames: configuredSecrets
			.map((secret) => secret.name)
			.filter((name) => !stageVariables.includes(name)),
		timeoutMs: REPLAY_DEFAULT_TIMEOUT_MS,
		...(options.executablePath === undefined
			? {}
			: { executablePath: options.executablePath }),
	});
	const secrets = configuredSecrets;
	const redactText = (text: string) => redact(text, secrets) as string;
	if (processResult.timedOut)
		return {
			id: flowId,
			flowId,
			status: "failed",
			code: "replay-timeout",
			error: redactText(
				processResult.stderr.slice(0, 500) ||
					processResult.stdout.slice(0, 500),
			),
		};
	let result: import("../src/contracts/stage-replay.ts").ReplayResult;
	try {
		result = decodeReplayResult(
			processResult.resultPath,
			{
				flowId,
				routeHash: entry.manifest.routeHash,
				inputsHash: canonicalInputsHash(inputs),
			},
			processResult.exitCode,
			redactText,
			{ stdout: processResult.stdout, stderr: processResult.stderr },
		);
	} catch (error) {
		return {
			id: flowId,
			flowId,
			status: "failed",
			code:
				error instanceof BrowserPoolError
					? error.code
					: "replay-result-invalid",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		id: flowId,
		flowId,
		status: result.status === "passed" ? "passed" : "failed",
		inputsHash: result.inputsHash,
		routeHash: result.routeHash,
		resultPath: processResult.resultPath,
		...(result.status === "passed"
			? {}
			: {
					code: "replay-failed",
					error: redactText(JSON.stringify(result).slice(0, 2_000)),
				}),
	};
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.flowId === undefined && options.suiteId === undefined)
		fail(
			"usage: stage-flow-run.ts --flow <flowId> | --suite <suiteId> --stage <stage> [--inputs <file.json>]",
		);
	if (options.flowId !== undefined && options.suiteId !== undefined)
		fail("pass exactly one of --flow or --suite");
	if (options.stage === undefined) fail("--stage is required");
	const stage = options.stage;

	if (options.flowId !== undefined) {
		const inputs: Readonly<Record<string, JsonValue>> = options.inputsFile
			? JSON.parse(fs.readFileSync(options.inputsFile, "utf8"))
			: {};
		const entryResult = await runOneFlow(
			options,
			options.flowId,
			stage,
			inputs,
		);
		console.log(JSON.stringify(entryResult, null, 2));
		process.exit(entryResult.status === "passed" ? 0 : 1);
	}

	const suiteId = options.suiteId;
	if (suiteId === undefined) fail("--suite is required here");
	const suites = readSuiteRegistry(options.root);
	const suiteEntry = suites.entries.find(
		(candidate) => candidate.manifest.suiteId === suiteId,
	);
	if (suiteEntry === undefined)
		fail(
			`suite ${suiteId} is not saved under stage-flows (${suites.issues.map((i) => i.message).join("; ")})`,
		);
	const manifest = suiteEntry.manifest as SuiteManifest;
	const run = async (entry: SuiteFlowEntry) => ({
		...(await runOneFlow(options, entry.flowId, stage, entry.inputs ?? {})),
		id: entry.id,
	});
	const outcome = await runSuiteEntries(manifest, run, {
		maxWorkers: Math.max(1, Math.min(os.cpus().length, 4)),
	});
	console.log(JSON.stringify(outcome, null, 2));
	process.exit(outcome.status === "passed" ? 0 : 1);
}

await main();
