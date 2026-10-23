// The browser tools of a durable agent run (`add-agent-browser-sessions`).
//
// `agentic.browser` gives every durable run — read-only verifiers included — the
// tools that drive a real headless browser against the apps its workflow holds.
// They never talk to Playwright themselves: every call goes to the server's
// owner-scoped `/api/v1/agent-env/browser/*` surface with the capability the run
// already holds, so a run can only ever drive its own sessions and can only
// resolve an app endpoint it actually holds.
//
// Two contract details are deliberate:
//
// * **`browser_snapshot` before acting.** The action tools take a `ref` from the
//   latest snapshot (preferred) or a Playwright selector. A ref that snapshot did
//   not produce is refused rather than silently resolving to another element.
// * **A screenshot is returned to the model.** It is an image content block, so
//   the model sees the page; it becomes evidence only when `evidence: true`, and
//   a recording leaves a file behind only when `keep: true`.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_EVAL_PATH,
	AGENT_BROWSER_FIND_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_LOGIN_WAIT_PATH,
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	AGENT_BROWSER_STAGE_BLOCK_SAVE_PATH,
	AGENT_BROWSER_STAGE_BLOCKS_PATH,
	AGENT_BROWSER_STAGE_FLOWS_PATH,
	AGENT_BROWSER_STAGE_JOURNAL_PATH,
	AGENT_BROWSER_STAGE_REPLAY_PATH,
	AGENT_BROWSER_STAGE_RUN_PATH,
	AGENT_BROWSER_STAGE_STEP_PATH,
	AGENT_BROWSER_STAGE_WAIT_PATH,
	AGENT_BROWSER_WAIT_PATH,
} from "../server/protocol.ts";
import { describeDataBlockOperations } from "../stage-blocks/data-block.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "./environment-capability.ts";
import { withoutBlankOptionals } from "./optional-arguments.ts";
import type { RunContextLookup } from "./tools.ts";

export const BROWSER_EXTENSION = "agentic.browser";

/** Tool output bound: a larger view is truncated rather than flooding context. */
const MAX_RESULT_CHARS = 40_000;
const READ_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 180_000;
/** One `stage_login_wait` call: the server caps the block at 600 s, and the
 * client bound is a little above it so the server's own answer arrives first. */
const LOGIN_WAIT_TIMEOUT_MS = 610_000;
const NAVIGATION_TIMEOUT_MS = 120_000;
const RECORDING_TIMEOUT_MS = 180_000;
/** A `stage_step` or `stage_journal` call is a page read plus a file write. */
const JOURNAL_TIMEOUT_MS = 60_000;
/** One `stage_wait`: the server caps its own poll at the stage's
 * `maxWaitSeconds`, and the client bound sits just above the largest cap so the
 * server's own answer arrives first. */
const STAGE_WAIT_TIMEOUT_MS = 660_000;
/** One reviewed plan may chain up to 100 blocks; each block has its own bounded
 * browser actions, so the call bound is larger than a single action. */
const STAGE_RUN_TIMEOUT_MS = 900_000;
const STAGE_REPLAY_TIMEOUT_MS = 960_000;

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };
type Result = { content: ContentBlock[]; isError?: boolean };

function text(value: unknown): Result {
	const raw =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return {
		content: [
			{
				type: "text",
				text:
					raw.length > MAX_RESULT_CHARS
						? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`
						: raw,
			},
		],
	};
}

function failure(message: string): Result {
	return { content: [{ type: "text", text: message }], isError: true };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** One short line, so the model sees the cost and the state without a JSON
 * envelope. It is deliberately value-free: counts, mode and durations only. */
function timingLine(value: unknown): string | undefined {
	const timing = recordOf(value);
	if (!timing) return undefined;
	const parts: string[] = [];
	if (timing.mode === "ai" || timing.mode === "legacy")
		parts.push(`mode=${timing.mode}`);
	for (const key of [
		"snapshotMs",
		"actionMs",
		"observeMs",
		"totalMs",
		"toolMs",
	] as const) {
		const number = timing[key];
		if (typeof number === "number") parts.push(`${key}=${number}`);
	}
	for (const key of ["chars", "refs", "resultChars"] as const) {
		const number = timing[key];
		if (typeof number === "number") parts.push(`${key}=${number}`);
	}
	if (timing.changed === true) parts.push("changed=yes");
	if (timing.truncated === true) parts.push("truncated=yes");
	return parts.length === 0 ? undefined : `timing: ${parts.join(" ")}`;
}

/** The block catalog as one line per block, or the full schema when the caller
 * asked for one id. The catalog is generated, so `digest` is the review token a
 * plan generator can cite without seeing the function source. */
function stageBlocksResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || !Array.isArray(record.blocks)) return text(value);
	const lines: string[] = [];
	if (record.mode === "compact" || record.mode === "full")
		lines.push(`mode: ${record.mode}`);
	if (typeof record.total === "number") lines.push(`total: ${record.total}`);
	// A refused document is not a silent omission: the caller has to know that the
	// catalog it just read is not the whole store (`USAB-003`).
	if (Array.isArray(record.diagnostics))
		for (const entry of record.diagnostics) {
			const diagnostic = recordOf(entry);
			if (diagnostic === undefined) continue;
			lines.push(
				`diagnostic: ${String(diagnostic.code)}${typeof diagnostic.id === "string" ? ` (${diagnostic.id})` : ""} ${String(diagnostic.message)}`,
			);
		}
	lines.push("");
	for (const entry of record.blocks) {
		const block = recordOf(entry);
		if (!block) continue;
		const effects = Array.isArray(block.effects)
			? block.effects.filter((effect) => typeof effect === "string").join("+")
			: "";
		lines.push(
			`${String(block.id)}@${String(block.version)} ${String(block.app)} [${effects}] ${
				typeof block.title === "string" ? block.title : ""
			}`.trimEnd(),
		);
		if (typeof block.description === "string" && block.description !== "")
			lines.push(`  ${block.description}`);
		if (Array.isArray(block.requires) && block.requires.length > 0)
			lines.push(`  requires: ${block.requires.join(", ")}`);
		if (Array.isArray(block.provides) && block.provides.length > 0)
			lines.push(`  provides: ${block.provides.join(", ")}`);
		// Role is part of the matching rule the planner follows, and a data block
		// authored for one role is refused for another (`USAB-102`). An empty list
		// means any role, which is what the checked-in blocks declare.
		if (Array.isArray(block.roles))
			lines.push(
				`  roles: ${block.roles.length === 0 ? "any" : block.roles.join(", ")}`,
			);
		if (block.idempotent === true) lines.push("  idempotent: yes");
		if (block.internal === true) lines.push("  internal: yes");
		// What the block promises, for both kinds: the postcondition belongs to a
		// checked-in block too (`USAB-104`).
		if (typeof block.postcondition === "string")
			lines.push(`  postcondition: ${block.postcondition}`);
		if (block.kind === "data") {
			lines.push(
				`  kind: data${block.status === "draft" ? " (draft: this run only)" : ""}`,
			);
			const document = recordOf(block.document);
			if (Array.isArray(document?.operations)) {
				const described = describeDataBlockOperations(
					document.operations as never,
					"    ",
				);
				lines.push("  operations:", ...described.slice(0, 24));
				if (described.length > 24) lines.push("    … (truncated)");
			}
		}
		if (recordOf(block.deprecated)) {
			const deprecated = recordOf(block.deprecated);
			lines.push(
				`  deprecated${
					typeof deprecated?.replacementId === "string"
						? `; replacement ${deprecated.replacementId}`
						: ""
				}`,
			);
		}
		if (block.params !== undefined || block.returns !== undefined)
			lines.push(
				`  schema: ${JSON.stringify({
					params: block.params,
					returns: block.returns,
					examples: block.examples,
				})}`,
			);
	}
	return text(lines.join("\n"));
}

/** A flow list as one line per reviewed spec. It exposes hashes and input
 * schemas, never input values. */
function stageFlowsResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || !Array.isArray(record.flows)) return text(value);
	const lines: string[] = [];
	if (typeof record.total === "number") lines.push(`total: ${record.total}`);
	lines.push("");
	for (const entry of record.flows) {
		const flow = recordOf(entry);
		if (!flow) continue;
		const apps = Array.isArray(flow.applications)
			? flow.applications.join(",")
			: "";
		const roles = Array.isArray(flow.roles) ? flow.roles.join(",") : "";
		lines.push(
			`${String(flow.flowId)} [${String(flow.stage)}] ${apps}${roles === "" ? "" : ` roles=${roles}`} — ${String(flow.title)}`,
		);
		if (typeof flow.routeHash === "string")
			lines.push(`  routeHash: ${flow.routeHash}`);
		if (typeof flow.specHash === "string")
			lines.push(`  specHash: ${flow.specHash}`);
		const schema = recordOf(flow.inputSchema);
		const properties = recordOf(schema?.properties);
		if (properties)
			for (const [name, property] of Object.entries(properties))
				lines.push(`  input ${name}: ${JSON.stringify(property)}`);
	}
	if (Array.isArray(record.issues))
		for (const entry of record.issues) {
			const problem = recordOf(entry);
			if (problem)
				lines.push(`issue: ${String(problem.code)} ${String(problem.message)}`);
		}
	return text(lines.join("\n"));
}

/** A replay result as a bounded ledger. A dry run never starts a process; a
 * real run names the journal and evidence ids and the heal packet instead of
 * dumping the Playwright report. */
function stageReplayResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || typeof record.flowId !== "string") return text(value);
	const lines: string[] = [];
	for (const key of ["flowId", "stage", "status"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	for (const key of ["planId", "revision"] as const) {
		const entry = record[key];
		if (typeof entry === "string" || typeof entry === "number")
			lines.push(`${key}: ${String(entry)}`);
	}
	for (const key of ["inputsHash", "routeHash", "specHash"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	if (typeof record.durationMs === "number")
		lines.push(`durationMs: ${record.durationMs}`);
	if (record.inputs !== undefined)
		lines.push(`inputs: ${JSON.stringify(record.inputs)}`);
	const dryRun = recordOf(record.dryRun);
	if (dryRun) {
		lines.push(
			"",
			`dryRun: ${dryRun.eligible === true ? "eligible" : "not eligible"}`,
		);
		if (dryRun.inputs !== undefined)
			lines.push(`inputs: ${JSON.stringify(dryRun.inputs)}`);
		const schema = recordOf(dryRun.inputSchema);
		const properties = recordOf(schema?.properties);
		if (properties)
			for (const [name, property] of Object.entries(properties))
				lines.push(`  input ${name}: ${JSON.stringify(property)}`);
		if (Array.isArray(dryRun.issues))
			for (const entry of dryRun.issues) {
				const problem = recordOf(entry);
				if (problem)
					lines.push(
						`issue: ${String(problem.code)} ${String(problem.message)}`,
					);
			}
	}
	if (Array.isArray(record.steps) && record.steps.length > 0) {
		lines.push("");
		for (const entry of record.steps) {
			const step = recordOf(entry);
			if (!step) continue;
			const journal = Array.isArray(step.journalIds)
				? step.journalIds.join(",")
				: "";
			const evidence = Array.isArray(step.evidenceIds)
				? step.evidenceIds.join(",")
				: "";
			lines.push(
				`${String(step.status)} [${String(step.index)}] ${String(step.routeStepId)} ${String(step.block)}@${String(step.version)} ${String(step.durationMs)}ms${journal === "" ? "" : ` journal=${journal}`}${evidence === "" ? "" : ` evidence=${evidence}`}`,
			);
			if (typeof step.error === "string" && step.error !== "")
				lines.push(`  error: ${step.error}`);
		}
	}
	const failure = recordOf(record.failure);
	if (failure) {
		lines.push("", `failure: ${String(failure.message)}`);
		if (failure.retryable === true) lines.push("retryable: yes");
	}
	const heal = recordOf(record.heal);
	if (heal) {
		lines.push("", `heal: ${String(heal.routeStepId)} ${String(heal.block)}`);
		if (typeof heal.evidenceId === "string")
			lines.push(`  evidence: ${heal.evidenceId}`);
		if (heal.retryable === true) lines.push("  retryable: yes");
	}
	const report = recordOf(record.report);
	const expectations = Array.isArray(report?.expectations)
		? report.expectations
		: [];
	if (expectations.length > 0) {
		const counts: Record<string, number> = {};
		for (const entry of expectations) {
			const expectation = recordOf(entry);
			const verdict = expectation?.verdict;
			if (typeof verdict === "string")
				counts[verdict] = (counts[verdict] ?? 0) + 1;
		}
		lines.push(
			"",
			`report: ${Object.entries(counts)
				.map(([verdict, count]) => `${verdict}=${count}`)
				.join(" ")}`,
		);
	}
	if (Array.isArray(record.issues))
		for (const entry of record.issues) {
			const problem = recordOf(entry);
			if (problem)
				lines.push(`issue: ${String(problem.code)} ${String(problem.message)}`);
		}
	return text(lines.join("\n"));
}

function stageSuiteResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || typeof record.suiteId !== "string") return text(value);
	const lines: string[] = [];
	for (const key of ["suiteId", "stage", "status"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	lines.push(
		`parallel: ${record.parallel === true ? "yes" : "no"}, stopOnFailure: ${record.stopOnFailure === true ? "yes" : "no"}`,
	);
	if (typeof record.durationMs === "number")
		lines.push(`durationMs: ${record.durationMs}`);
	if (typeof record.resultEvidenceId === "string")
		lines.push(`resultEvidenceId: ${record.resultEvidenceId}`);
	if (Array.isArray(record.entries) && record.entries.length > 0) {
		lines.push("");
		for (const raw of record.entries) {
			const entry = recordOf(raw);
			if (!entry) continue;
			const evidence = Array.isArray(entry.evidenceIds)
				? entry.evidenceIds.join(",")
				: "";
			lines.push(
				`${String(entry.status)} ${String(entry.id)} (${String(entry.flowId)})${typeof entry.inputsHash === "string" ? ` inputsHash=${entry.inputsHash}` : ""}${evidence === "" ? "" : ` evidence=${evidence}`}`,
			);
			if (typeof entry.code === "string") lines.push(`  code: ${entry.code}`);
			if (typeof entry.error === "string" && entry.error !== "")
				lines.push(`  error: ${entry.error}`);
		}
	}
	if (Array.isArray(record.issues))
		for (const entry of record.issues) {
			const problem = recordOf(entry);
			if (problem)
				lines.push(`issue: ${String(problem.code)} ${String(problem.message)}`);
		}
	return text(lines.join("\n"));
}

/** A plan result as a compact ledger. The journal and evidence hold the detail;
 * the model only needs what passed, what failed and where to look next. */
function stageRunResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || !Array.isArray(record.steps)) return text(value);
	const lines: string[] = [];
	for (const key of ["planId", "flowId", "stage", "status"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	if (typeof record.revision === "number")
		lines.push(`revision: ${record.revision}`);
	if (typeof record.inputsHash === "string")
		lines.push(`inputsHash: ${record.inputsHash}`);
	if (typeof record.durationMs === "number")
		lines.push(`durationMs: ${record.durationMs}`);
	lines.push("");
	for (const entry of record.steps) {
		const step = recordOf(entry);
		if (!step) continue;
		const journal = Array.isArray(step.journalIds)
			? step.journalIds.join(",")
			: "";
		const evidence = Array.isArray(step.evidenceIds)
			? step.evidenceIds.join(",")
			: "";
		lines.push(
			`${String(step.status)} [${String(step.index)}] ${String(step.routeStepId)} ${String(
				step.block,
			)}@${String(step.version)} ${String(step.durationMs)}ms${
				step.retries === 1 ? " retry=1" : ""
			}${journal === "" ? "" : ` journal=${journal}`}${
				evidence === "" ? "" : ` evidence=${evidence}`
			}`,
		);
		if (typeof step.error === "string" && step.error !== "")
			lines.push(`  error: ${step.error}`);
	}
	const failure = recordOf(record.failure);
	if (failure) {
		lines.push("", `failure: ${String(failure.message)}`);
		if (failure.retryable === true) lines.push("retryable: yes");
	}
	const dryRun = recordOf(record.dryRun);
	if (dryRun) {
		lines.push("", `dryRun: ${dryRun.ok === true ? "ok" : "refused"}`);
		const schema = recordOf(dryRun.inputSchema);
		const properties = recordOf(schema?.properties);
		if (properties)
			for (const [name, property] of Object.entries(properties))
				lines.push(`  input ${name}: ${JSON.stringify(property)}`);
		if (Array.isArray(dryRun.issues))
			for (const entry of dryRun.issues) {
				const problem = recordOf(entry);
				if (problem)
					lines.push(
						`issue: ${String(problem.code)}${
							typeof problem.routeStepId === "string"
								? ` (${problem.routeStepId})`
								: ""
						} ${String(problem.message)}`,
					);
			}
	}
	const saved = recordOf(record.saved);
	if (saved) {
		lines.push(
			"",
			`saved: ${String(saved.flowId)}${saved.existing === true ? " (unchanged)" : ""}`,
		);
		if (typeof saved.specPath === "string")
			lines.push(`  spec: ${saved.specPath}`);
		if (typeof saved.manifestPath === "string")
			lines.push(`  manifest: ${saved.manifestPath}`);
	}
	if (Array.isArray(record.issues))
		for (const entry of record.issues) {
			const problem = recordOf(entry);
			if (problem)
				lines.push(
					`issue: ${String(problem.code)}${typeof problem.routeStepId === "string" ? ` (${problem.routeStepId})` : ""} ${String(problem.message)}`,
				);
		}
	return text(lines.join("\n"));
}

/** A saved draft's one-paragraph receipt: what the block is, the digest a plan
 * pins, and that review still has to promote it. */
function stageBlockSaveResult(value: unknown): Result {
	const record = recordOf(value);
	if (record?.status !== "draft") return text(value);
	const lines = [
		`draft: ${String(record.id)}@${String(record.version)} ${String(record.app)} [${Array.isArray(record.effects) ? record.effects.join("+") : ""}]`,
		`stage: ${String(record.stage)}`,
		`digest: ${String(record.digest)}`,
	];
	if (recordOf(record.replaced) !== undefined)
		lines.push(`replaced: ${String(recordOf(record.replaced)?.version)}`);
	if (Array.isArray(record.proofs) && record.proofs.length > 0)
		lines.push(
			`proofs: ${record.proofs
				.map((proof) => {
					const entry = recordOf(proof);
					return entry === undefined
						? ""
						: `${String(entry.status)}@${String(entry.at)}`;
				})
				.filter((line) => line !== "")
				.join(", ")}`,
		);
	if (Array.isArray(record.warnings))
		for (const warning of record.warnings)
			if (typeof warning === "string") lines.push(`warning: ${warning}`);
	lines.push(
		"",
		"Run it with stage_run (the draft is executable in this run only); review approval promotes it into the shared store.",
	);
	return text(lines.join("\n"));
}

/** The default text view for an action/wait/script result. The observation is
 * already compact; the structured delta stays out of the model output because
 * the observation names the same changes in fewer tokens. */
function observationResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || typeof record.observation !== "string") return text(value);
	const lines: string[] = [];
	for (const key of ["session", "action", "url", "title"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	if (typeof record.snapshotId === "string")
		lines.push(`snapshotId: ${record.snapshotId}`);
	if (record.mode === "ai" || record.mode === "legacy")
		lines.push(`mode: ${record.mode}`);
	if (record.snapshotRequired === true)
		lines.push(
			"snapshotRequired: true — call browser_snapshot before the next ref action",
		);
	lines.push("", record.observation);
	const timing = timingLine(record.timing);
	if (timing) lines.push("", timing);
	return text(lines.join("\n"));
}

/** A find answer as one line per match, never as the parseable node map. */
function findResult(value: unknown): Result {
	const record = recordOf(value);
	if (!record || !Array.isArray(record.matches)) return text(value);
	const lines: string[] = [];
	for (const key of ["session", "snapshotId"] as const) {
		const entry = record[key];
		if (typeof entry === "string" && entry !== "")
			lines.push(`${key}: ${entry}`);
	}
	if (record.mode === "ai" || record.mode === "legacy")
		lines.push(`mode: ${record.mode}`);
	if (typeof record.total === "number")
		lines.push(`matches: ${record.matches.length} of ${record.total}`);
	if (record.truncated === true) lines.push("truncated: true");
	lines.push("");
	if (record.matches.length === 0) lines.push("(no matches)");
	for (const match of record.matches) {
		const node = recordOf(match);
		if (!node) continue;
		const ref = typeof node.ref === "string" ? `[${node.ref}] ` : "";
		const role = typeof node.role === "string" ? node.role : "node";
		const name = typeof node.name === "string" ? ` "${node.name}"` : "";
		const text =
			typeof node.text === "string" && node.text !== "" ? `: ${node.text}` : "";
		lines.push(`- ${ref}${role}${name}${text}`);
	}
	const timing = timingLine(record.timing);
	if (timing) lines.push("", timing);
	return text(lines.join("\n"));
}

/** One authenticated call to the server's owner-scoped browser surface.
 * Resolves to the envelope's `value`; rejects with the server's message, which
 * already carries the refusal code (`app-not-held`, `script-timeout`, …). */
async function call(
	env: Readonly<Record<string, string>>,
	method: "GET" | "POST",
	path: string,
	init: { body?: unknown; timeoutMs: number },
): Promise<unknown> {
	const startedAt = performance.now();
	const binding = bindingOf(env);
	if (!binding) throw new Error(NO_BINDING);
	const response = await fetch(`${binding.url}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${binding.token}`,
			[ENVIRONMENT_OWNER_HEADER]: binding.owner,
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(init.body === undefined
			? {}
			: { body: JSON.stringify(withoutBlankOptionals(init.body)) }),
		signal: AbortSignal.timeout(init.timeoutMs),
	});
	const parsed = (await response.json().catch(() => undefined)) as
		| {
				ok?: boolean;
				value?: unknown;
				error?: { code?: string; message?: string };
		  }
		| undefined;
	if (!response.ok || !parsed || parsed.ok === false || parsed.error) {
		const code = parsed?.error?.code;
		throw new Error(
			`${parsed?.error?.message ?? `the browser server answered ${response.status}`}${code ? ` [${code}]` : ""}`,
		);
	}
	const value = parsed.value;
	// `toolMs` is measured at the client boundary, so it includes the transport
	// and the JSON decode; `resultChars` is what the model actually receives.
	// Both live under the existing timing object rather than changing a result
	// shape per tool.
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const timing = record.timing;
		if (timing !== null && typeof timing === "object") {
			record.timing = {
				...(timing as Record<string, unknown>),
				toolMs: Math.round((performance.now() - startedAt) * 10) / 10,
				resultChars: JSON.stringify(value).length,
			};
		}
	}
	return value;
}

interface BrowserBinding {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
}

function bindingOf(
	env: Readonly<Record<string, string>>,
): BrowserBinding | undefined {
	const url = env[ENVIRONMENT_URL_ENV];
	const token = env[ENVIRONMENT_TOKEN_ENV];
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (!url || !token || !workflowId) return undefined;
	return { url, token, owner: environmentOwnerFor(workflowId) };
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the browser tools are unavailable";

const SessionParameter = Type.Optional(
	Type.String({
		description:
			"Which session to use: the run's own pages are addressed by name, and the one opened without a name is `default`.",
	}),
);

const TargetParameters = {
	ref: Type.Optional(
		Type.String({
			description:
				"An element ref from the latest browser_snapshot (`[ref=eN]`). Preferred over a selector.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"An optional Playwright selector, when no snapshot ref names the element.",
		}),
	),
};

const BrowserOpenParameters = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"The URL to open. Any URL is allowed, except in a session already bound to a stage: there the URL's origin must be one the stage allow-lists (`origin-not-allowed` otherwise).",
		}),
	),
	app: Type.Optional(
		Type.String({
			description:
				"An app ident from env_list, instead of a raw url; requires this workflow to hold the app.",
		}),
	),
	endpoint: Type.Optional(
		Type.String({
			description:
				"The endpoint name the app exports (from env_start's endpoints), resolved to its URL.",
		}),
	),
	stage: Type.Optional(
		Type.String({
			description:
				"An allow-listed stage ident from stage_info. Opens the stage's application at its configured URL and binds the session to that stage for the session's whole life: every main-frame navigation stays on the stage's allow-list, a read-only stage refuses state-changing requests, and stage_login becomes available. An unknown or refused stage answers `stage-not-configured`.",
		}),
	),
	stageApp: Type.Optional(
		Type.String({
			description:
				"The stage application key to open (from stage_info), required with `stage`.",
		}),
	),
	stageRole: Type.Optional(
		Type.String({
			description:
				'The role whose cached sign-in this session should start from (from stage_info). With a live cache entry for `(stage, stageRole)` the server installs its cookies and storage before the page\'s first request, so stage_login often reaches the success condition without a developer prompt and answers `identity: "cache"`. Absent means an empty browser, which is what every stage session did before. A role the application does not declare answers `stage-role-unknown`.',
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"An optional path appended to the stage application's configured URL.",
		}),
	),
	session: SessionParameter,
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number({ description: "Viewport width in CSS pixels." }),
			height: Type.Number({ description: "Viewport height in CSS pixels." }),
		}),
	),
});

const BrowserSessionParameters = Type.Object({
	session: SessionParameter,
});

const BrowserSnapshotParameters = Type.Object({
	session: SessionParameter,
	within: Type.Optional(
		Type.String({
			description:
				"Scope the snapshot to one ref from the current state or a Playwright selector, instead of reading the whole page.",
		}),
	),
	depth: Type.Optional(
		Type.Number({
			description:
				"Maximum snapshot depth (default 10, max 14). Lower is cheaper; the returned refs are the only ones actionable.",
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description:
				"Character budget (default 20,000, max 40,000). The cut is at a line boundary; only returned refs are actionable.",
		}),
	),
	diff: Type.Optional(
		Type.Boolean({
			description:
				"Return a compact diff against the previous snapshot instead of the tree. Use after a navigation or a large re-render, or `since` for a retained earlier state.",
		}),
	),
	since: Type.Optional(
		Type.String({
			description:
				"A retained snapshotId to diff against (default: the previous snapshot).",
		}),
	),
});

const BrowserFindParameters = Type.Object({
	session: SessionParameter,
	query: Type.String({
		description:
			"Case-insensitive text matched against role, accessible name and node text. Use this instead of a full snapshot when you know what you are looking for.",
	}),
	role: Type.Optional(
		Type.String({ description: "Keep only this ARIA role, e.g. button." }),
	),
	name: Type.Optional(
		Type.String({
			description: "Keep only nodes whose accessible name contains this text.",
		}),
	),
	within: Type.Optional(
		Type.String({
			description:
				"Search only inside a ref from the current state or a Playwright selector.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum matches to return (max 20)." }),
	),
});

/** The credential reference `browser_fill` accepts instead of a literal value. */
const CredentialParameter = Type.Optional(
	Type.Object(
		{
			app: Type.String({
				description: "The stage application key the role belongs to.",
			}),
			role: Type.String({ description: "The role name of that application." }),
			field: Type.Union(
				[
					Type.Literal("username"),
					Type.Literal("password"),
					Type.Literal("totp"),
				],
				{
					description:
						"Which credential of the role to fill. A `totp` field is filled with a code computed now from the referenced secret.",
				},
			),
		},
		{
			description:
				"Fill the resolved credential of one role field instead of a literal `value`, on a session bound to a stage. The value never travels: the server reads it from the configuration `.env`. Use this rather than typing a credential you were told about, and never pass a credential as `value`.",
		},
	),
);

/** One tool per action, so the model never has to remember a discriminator. */
function actionTool(
	lookup: RunContextLookup,
	action: "click" | "fill" | "press" | "select" | "hover",
	name: string,
	description: string,
	specific: Record<string, unknown>,
) {
	return defineTool({
		name,
		description,
		parameters: Type.Object({
			...TargetParameters,
			session: SessionParameter,
			snapshotId: Type.Optional(
				Type.String({
					description:
						"The snapshotId the ref came from. When supplied, a stale id is refused before the page is touched.",
				}),
			),
			...specific,
		}),
		execute: async (args, api) => {
			const run = lookup(api.conversationId);
			if (!run) return failure(`${name}: run context unavailable`);
			const extra = args as Record<string, unknown>;
			const body: Record<string, unknown> = {
				action,
				...(extra.snapshotId === undefined
					? {}
					: { snapshotId: extra.snapshotId }),
				...(extra.ref === undefined ? {} : { ref: extra.ref }),
				...(extra.selector === undefined ? {} : { selector: extra.selector }),
				...(extra.session === undefined ? {} : { session: extra.session }),
				...(extra.value === undefined ? {} : { value: extra.value }),
				...(extra.credential === undefined
					? {}
					: { credential: extra.credential }),
				...(extra.key === undefined ? {} : { key: extra.key }),
				...(extra.values === undefined ? {} : { values: extra.values }),
				...(extra.timeoutMs === undefined
					? {}
					: { timeoutMs: extra.timeoutMs }),
			};
			try {
				return observationResult(
					await call(run.env, "POST", AGENT_BROWSER_ACTION_PATH, {
						timeoutMs: ACTION_TIMEOUT_MS,
						body,
					}),
				);
			} catch (error) {
				return failure(`${name}: ${message(error)}`);
			}
		},
	});
}

const BrowserWaitParameters = Type.Object({
	...TargetParameters,
	session: SessionParameter,
	text: Type.Optional(
		Type.String({ description: "Wait until this text is visible." }),
	),
	url: Type.Optional(
		Type.String({ description: "Wait until the URL matches this pattern." }),
	),
	observe: Type.Optional(
		Type.Boolean({
			description:
				"Return the compact post-wait observation and the resulting snapshotId, instead of spending a separate browser_snapshot turn.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "How long to wait, in ms." }),
	),
});

const BrowserEvalParameters = Type.Object({
	code: Type.String({
		description:
			"JavaScript evaluated in the page; the resolved value is returned.",
	}),
	session: SessionParameter,
	timeoutMs: Type.Optional(
		Type.Number({ description: "How long the evaluation may take, in ms." }),
	),
});

const BrowserLogParameters = Type.Object({
	session: SessionParameter,
	level: Type.Optional(
		Type.String({
			description: "Keep only console entries of this level (browser_console).",
		}),
	),
	status: Type.Optional(
		Type.Number({
			description: "Keep only responses with this status (browser_network).",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "Keep only entries whose URL contains this substring.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "How many entries to return (newest first)." }),
	),
});

const BrowserScreenshotParameters = Type.Object({
	...TargetParameters,
	session: SessionParameter,
	fullPage: Type.Optional(
		Type.Boolean({
			description:
				"Capture the whole scrollable page (default true). Pass false for the visible viewport only.",
		}),
	),
	evidence: Type.Optional(
		Type.Boolean({
			description:
				"Store the screenshot as evidence (default false: it is only returned to you).",
		}),
	),
	view: Type.Optional(
		Type.Boolean({
			description:
				"`view: false` stores the screenshot (needs `evidence: true`) and answers with the evidence id and caption only, so a long flow test does not inflate your context with images you would not inspect anyway.",
		}),
	),
	caption: Type.Optional(
		Type.String({
			description:
				"One line the developer reads next to the evidence, saying what it shows.",
		}),
	),
});

const StageWaitParameters = Type.Object({
	session: SessionParameter,
	until: Type.Object({
		text: Type.Optional(
			Type.String({ description: "Wait until this text is on the page." }),
		),
		selector: Type.Optional(
			Type.String({ description: "Wait until this CSS selector matches." }),
		),
		url: Type.Optional(
			Type.String({
				description:
					"Wait until the URL matches this pattern (`*` wildcards; without one it is a substring).",
			}),
		),
		mail: Type.Optional(
			Type.Object({
				to: Type.Optional(
					Type.String({
						description: "Mailpit search: the recipient address.",
					}),
				),
				subject: Type.Optional(
					Type.String({ description: "Mailpit search: the subject." }),
				),
			}),
		),
	}),
	reload: Type.Optional(
		Type.Boolean({
			description:
				"Re-open the session's current URL between polls (a mail-driven page has to be re-read to show the message's effect).",
		}),
	),
	intervalSeconds: Type.Optional(
		Type.Number({ description: "How often to poll, in seconds (default 5)." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"How long to wait, in seconds; capped by the stage's `maxWaitSeconds`.",
		}),
	),
});

const StageStepParameters = Type.Object({
	session: SessionParameter,
	label: Type.String({
		description:
			"The step itself, in the operator's words (e.g. `submit the request`). The server adds the time, the application, the role, the URL and — while a recording runs — the segment and offset.",
	}),
	expected: Type.Optional(
		Type.String({ description: "What should have happened, if it matters." }),
	),
	observed: Type.Optional(
		Type.String({ description: "What actually happened." }),
	),
	captures: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Values this step produced, as name → value (a reference number, a status, an amount). Redacted before the journal is written.",
		}),
	),
	evidence: Type.Optional(
		Type.Array(
			Type.String({
				description: "The id of a screenshot or video already attached.",
			}),
			{
				description:
					"The evidence ids this step shows. An id the manifest does not hold is refused.",
			},
		),
	),
	knowledge: Type.Optional(
		Type.Object({
			concept: Type.String({
				description: "The process concept or rule the step illustrates.",
			}),
			section: Type.Optional(
				Type.String({ description: "Where the concept is documented." }),
			),
			kind: Type.Union(
				[
					Type.Literal("confirmed"),
					Type.Literal("contradicted"),
					Type.Literal("missing"),
					Type.Literal("new"),
				],
				{
					description:
						"What the step showed about that concept: confirmed, contradicted, missing or new.",
				},
			),
			suspectedCause: Type.Optional(
				Type.Union(
					[
						Type.Literal("product-change"),
						Type.Literal("regression"),
						Type.Literal("unknown"),
					],
					{
						description:
							"For a contradiction: whether the product changed on purpose, regressed, or you cannot tell.",
					},
				),
			),
		}),
	),
});

const BrowserRecordParameters = Type.Object({
	session: SessionParameter,
	keep: Type.Optional(
		Type.Boolean({
			description:
				"browser_record_stop only: keep the video (and its poster) as evidence. `false` deletes it.",
		}),
	),
	caption: Type.Optional(
		Type.String({
			description: "browser_record_stop only: what the recording shows.",
		}),
	),
});

const BrowserScriptParameters = Type.Object({
	code: Type.String({
		description:
			"Playwright JavaScript, run as an async function of (page, context, expect) against this session.",
	}),
	session: SessionParameter,
	save: Type.Optional(
		Type.Boolean({
			description:
				"Store a rerunnable repro.spec.ts (wrapped in a @playwright/test spec with the page URL) as script evidence.",
		}),
	),
	caption: Type.Optional(
		Type.String({ description: "What the saved spec reproduces." }),
	),
	observe: Type.Optional(
		Type.Boolean({
			description:
				"Return the compact post-script observation and the resulting snapshotId instead of a separate snapshot turn.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"How long the script may run, in ms (default 60s, max 10min).",
		}),
	),
});

const StageBlocksParameters = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"One block id; returns the full parameter/return schema, examples and digest.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Case-insensitive search over id, title and state.",
		}),
	),
	app: Type.Optional(
		Type.String({
			description: "Only blocks scoped to this stage application.",
		}),
	),
	effect: Type.Optional(
		Type.Union(
			[
				Type.Literal("read"),
				Type.Literal("write"),
				Type.Literal("destructive"),
			],
			{ description: "Only blocks declaring this effect." },
		),
	),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Return full schemas for the filtered list (default: compact).",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum entries to return (default 20, max 100).",
		}),
	),
});

const StageRunParameters = Type.Object({
	plan: Type.Unknown({
		description:
			"A standalone { planId?, flowId?, revision?, inputs?, steps } document: one step per reviewed block, each with its own `args`. The tester chooses the route, so no plan approval is involved.",
	}),
	session: SessionParameter,
	stageApp: Type.Optional(
		Type.String({
			description: "The application whose URL a `*` block should use.",
		}),
	),
	role: Type.Optional(
		Type.String({
			description:
				"The stage role this plan runs as; checked against app and block scopes.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description:
				"Validate the plan and input schema without opening a browser or executing a block.",
		}),
	),
	save: Type.Optional(
		Type.Boolean({
			description:
				"Save the plan as a replayable flow; the plan must carry a `flowId`.",
		}),
	),
});

/** A complete, valid `format: 1` block: the shape `stage_block_save` documents to
 * the tester, validated by a test so the description cannot drift. */
export const STAGE_BLOCK_EXAMPLE = {
	format: 1,
	id: "web.page.openAndRead",
	version: "1.0.0",
	app: "web",
	roles: ["user"],
	title: "Open a page and read its heading",
	description: "Opens /pages/<slug> and reads the h1.",
	effects: ["read"],
	idempotent: true,
	params: {
		type: "object",
		additionalProperties: false,
		properties: { slug: { type: "string", minLength: 1 } },
		required: ["slug"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: { heading: { type: "string" } },
		required: ["heading"],
	},
	examples: [{ slug: "start" }],
	postcondition: "the page heading is shown",
	operations: [
		{
			op: "step",
			label: "open",
			expected: "heading visible",
			operations: [
				{ op: "goto", path: "/pages/{{ args.slug }}" },
				{ op: "expectVisible", target: { role: "heading" } },
				{ op: "read", target: { role: "heading" }, into: "heading" },
			],
		},
	],
} as const;

const StageBlockSaveParameters = Type.Object({
	document: Type.Unknown({
		description: `The block as a \`format: 1\` JSON document: id, version, title, description, app, roles, effects, idempotent, requires, provides, params, returns, examples, postcondition and operations. Operations are \`step\`/\`optional\` groups of goto, click, fill, type, press, select, waitFor, wait, expectVisible, expectText, capture and read; a value is a bounded string, \`{{ args.<name> }}\` interpolation or \`{ secret: "<name>" }\`. Top-level operations are ONLY \`{op:"step",label,expected?,operations:[actions]}\` or \`{op:"optional",reason,operations:[actions]}\`; actions go inside them and take a \`target\` of \`{role,name?}\`, \`{label}\`, \`{testId}\`, \`{text}\` or \`{selector}\`. \`params\`/\`returns\` are JSON schemas with \`additionalProperties:false\`; \`examples\` is a list of plain argument objects (no \`args\` wrapper); omit \`requires\`/\`provides\` unless non-empty. Minimal example: ${JSON.stringify(STAGE_BLOCK_EXAMPLE)}.`,
	}),
	// The draft's plan id and revision are the engine's: `stage_block_save` reads
	// them from the workflow's own pinned plan, so there is no parameter for them
	// (`OSV-020`).
	session: SessionParameter,
});

const StageFlowsParameters = Type.Object({
	stage: Type.Optional(
		Type.String({
			description: "Filter to flows saved for this stage ident.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"Case-insensitive substring of flow id, title or application.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum flows to return (default 50, max 100).",
		}),
	),
});

const StageReplayParameters = Type.Object({
	flowId: Type.Optional(
		Type.String({
			description:
				"A saved flow id. Omit both flowId and suiteId to list the eligible checked-in flows instead of replaying.",
		}),
	),
	suiteId: Type.Optional(
		Type.String({
			description:
				"A saved suite id: runs every entry's flow through the same single-flow eligibility gate flowId would, bounded by parallel/stopOnFailure, and returns an aggregate pass/fail. Mutually exclusive with flowId.",
		}),
	),
	stage: Type.Optional(
		Type.String({
			description:
				"The stage ident; defaults to the workflow's pinned stage and is refused if it differs.",
		}),
	),
	inputs: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Replay inputs for a flowId call, validated against the flow's own input schema; omit them to run the flow's recorded example. Never put a secret here. Ignored for a suiteId call, where each entry carries its own inputs.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description:
				"Validate the flow, its spec, the block registry and the inputs without starting a browser.",
		}),
	),
	role: Type.Optional(
		Type.String({
			description: "The stage role to run as.",
		}),
	),
});

/** `agentic.browser`: the browser tool surface of one durable run. */
export function createBrowserExtension(lookup: RunContextLookup) {
	return defineExtension({
		name: BROWSER_EXTENSION,
		tools: [
			defineTool({
				name: "browser_open",
				description: [
					"Open a page in a headless browser and get back the session, URL and viewport.",
					"Give a raw `url`, or an `app` plus `endpoint` from env_list/env_start — an endpoint resolves only while this workflow holds that app, and otherwise fails with `app-not-held` naming the holder.",
					"`session` opens (or reuses) a named page; the unnamed session is `default`. Sessions are isolated browser contexts, capped by browser.max_sessions with FIFO queueing and closed when the run ends or idles past its TTL.",
					"Give `stage` plus `stageApp` (both from stage_info) to open a hosted stage application instead: the URL comes from the stage catalog, and the session stays on the stage's origin allow-list for its whole life.",
					"Add `stageRole` to start that session from the role's cached sign-in: the server installs the cached cookies and storage before the page's first request, and stage_login reports `identity: \"cache\"` when the application accepts them. The cache is bounded, exists only in this server's memory, and its values are never returned or stored anywhere.",
					// The browser is the server's own, not a configured service: an agent that
					// went looking for the `playwright-server` infrastructure (or port 3050)
					// spent calls on something this surface never uses.
					"The browser is the workflow server's own: one Playwright-driven Chromium in this process, launched locally from an installed system Chrome or from the browser installed under this configuration; it does not use the configured playwright-server infrastructure service.",
					"Call browser_snapshot next: the action tools take the refs it returns.",
				].join(" "),
				parameters: BrowserOpenParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_open: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_OPEN_PATH, {
								timeoutMs: NAVIGATION_TIMEOUT_MS,
								body: {
									...(args.url === undefined ? {} : { url: args.url }),
									...(args.app === undefined ? {} : { app: args.app }),
									...(args.endpoint === undefined
										? {}
										: { endpoint: args.endpoint }),
									...(args.stage === undefined ? {} : { stage: args.stage }),
									...(args.stageApp === undefined
										? {}
										: { stageApp: args.stageApp }),
									...(args.stageRole === undefined
										? {}
										: { stageRole: args.stageRole }),
									...(args.path === undefined ? {} : { path: args.path }),
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.viewport === undefined
										? {}
										: { viewport: args.viewport }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_open: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_login",
				description: [
					"Log a stage-bound session in with the role's declared recipe: the server resolves the role's credential references from the configuration `.env` at call time, types them and waits for the login to complete.",
					"Use it on a session opened with `browser_open({ stage, stageApp })`; it answers the sanitized landing URL, or `credential-missing` naming the variable to set in Settings → Stages, `login-step-not-found`, `login-mfa-required` (the page asks for a second factor the recipe does not provide), `login-timeout`, `login-failed` or `login-not-required` for an application without roles.",
					"When no credentials are configured (or the role's login needs a step the server cannot automate), it answers `login-needs-user` and hands the login to the developer in a visible, agentic-coding-owned browser window. Then call `stage_login_wait` and wait *inside* that tool — the run is not blocked, so never hand off `blocked` for a hand-off. Its terminal outcomes are `ok`, `login-handoff-unverified`, `login-handoff-timeout`, `login-handoff-aborted` and `login-failed` (the sign-in ended without a token).",
					"An `oauth2` role whose grant is `authorization_code` is a hand-off too: the window opens on the provider's own sign-in page and the server receives the provider's redirect on a loopback receiver it opened for this one login, so nothing has to be pasted back and no code or token ever reaches this call.",
					"Its arguments, results, errors and telemetry never contain a credential value — do not try to read one, and never pass one to another tool. While the hand-off runs the session is held by the developer: every other browser tool on it is refused with `session-held-by-user`.",
				].join(" "),
				parameters: Type.Object({
					app: Type.String({
						description: "The stage application key to log in to.",
					}),
					role: Type.String({
						description:
							"The role to log in as (from stage_info), e.g. a read-only clerk role.",
					}),
					session: SessionParameter,
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_login: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_LOGIN_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									app: args.app,
									role: args.role,
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_login: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_login_wait",
				description: [
					"Wait in the server for the login hand-off a `stage_login` call started on this session. The block is bounded by the smaller of the hand-off's remaining deadline and 600 s per call; each call counts as one stage action, and no model turn is spent while it waits.",
					"It answers `login-needs-user` again while the developer is still logging in (call it once more), or one terminal outcome: `ok` with `via`, `verified` and the landing URL; `login-handoff-unverified` when the developer chose Done but the declared success condition did not hold; `login-handoff-timeout` when the deadline passed; `login-handoff-aborted` with `by` (`developer`, `agent`, `window-closed`, `run-ended`); `login-failed` when the sign-in ended without a token (a `state` mismatch, the provider's own error, or a refused exchange).",
					"A terminal outcome means the login did not happen and the run is blocked with that code as its reason — report it through the normal handoff path with that reason rather than retrying blindly; a retry is a fresh `stage_login`. Do not call this for a session with no pending hand-off.",
				].join(" "),
				parameters: Type.Object({
					session: SessionParameter,
					timeoutSec: Type.Optional(
						Type.Number({
							description:
								"How long this call may block, in seconds. The server caps it at 600 s and at the hand-off's remaining deadline, whichever is smaller.",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_login_wait: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_LOGIN_WAIT_PATH, {
								timeoutMs: LOGIN_WAIT_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.timeoutSec === undefined
										? {}
										: { timeoutSec: args.timeoutSec }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_login_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_snapshot",
				description:
					"Return the bounded AI accessibility tree of the session's page with `[ref=eN]`/`[ref=f1e3]` element refs, plus a `snapshotId`. Pass a ref and that id to browser_click/fill/press/select/hover; each action answers with a compact delta and the resulting id, so do not snapshot again after every click. Use `within` for a scoped read, `diff` for a summary against the previous state, and browser_find when you know what you are looking for.",
				parameters: BrowserSnapshotParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_snapshot: run context unavailable");
					try {
						const value = (await call(
							run.env,
							"POST",
							AGENT_BROWSER_SNAPSHOT_PATH,
							{
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.within === undefined ? {} : { within: args.within }),
									...(args.depth === undefined ? {} : { depth: args.depth }),
									...(args.maxChars === undefined
										? {}
										: { maxChars: args.maxChars }),
									...(args.diff === undefined ? {} : { diff: args.diff }),
									...(args.since === undefined ? {} : { since: args.since }),
								},
							},
						)) as {
							url?: string;
							snapshot?: string;
							refs?: number;
							snapshotId?: string;
							observation?: string;
							since?: string;
							mode?: string;
							timing?: unknown;
						};
						const header = [
							`url: ${value.url ?? ""}`,
							...(value.snapshotId === undefined
								? []
								: [`snapshotId: ${value.snapshotId}`]),
							...(value.since === undefined ? [] : [`since: ${value.since}`]),
							`refs: ${value.refs ?? 0}`,
							...(value.mode === undefined ? [] : [`mode: ${value.mode}`]),
							...(timingLine(value.timing) === undefined
								? []
								: [timingLine(value.timing) as string]),
						].join("\n");
						const body = value.observation ?? value.snapshot ?? "";
						return {
							content: [
								{
									type: "text",
									text: `${header}\n\n${body.slice(0, MAX_RESULT_CHARS)}`,
								},
							],
						};
					} catch (error) {
						return failure(`browser_snapshot: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_find",
				description:
					"Search the current snapshot state by role/name/text and return only matching refs, without returning the tree. Use this after a navigation or when a full snapshot would be mostly irrelevant.",
				parameters: BrowserFindParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_find: run context unavailable");
					try {
						return findResult(
							await call(run.env, "POST", AGENT_BROWSER_FIND_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									query: args.query,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.role === undefined ? {} : { role: args.role }),
									...(args.name === undefined ? {} : { name: args.name }),
									...(args.within === undefined ? {} : { within: args.within }),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_find: ${message(error)}`);
					}
				},
			}),
			actionTool(
				lookup,
				"click",
				"browser_click",
				"Click the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{},
			),
			actionTool(
				lookup,
				"fill",
				"browser_fill",
				"Fill an input named by a ref from the latest browser_snapshot (preferred) or a selector with `value` — or, on a session bound to a stage, with `credential: { app, role, field }`, which the server resolves from the configuration `.env` so the value never enters this conversation.",
				{
					value: Type.Optional(
						Type.String({
							description: "The text to type into the field.",
						}),
					),
					credential: CredentialParameter,
				},
			),
			actionTool(
				lookup,
				"press",
				"browser_press",
				"Press `key` (for example Enter) on the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{ key: Type.String({ description: "The key to press, e.g. Enter." }) },
			),
			actionTool(
				lookup,
				"select",
				"browser_select",
				"Choose one or more options (by value or label) in a `<select>` named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{
					values: Type.Array(Type.String(), {
						description: "The option value(s) or label(s) to select.",
					}),
				},
			),
			actionTool(
				lookup,
				"hover",
				"browser_hover",
				"Hover the element named by a ref from the latest browser_snapshot (preferred) or a selector.",
				{},
			),
			defineTool({
				name: "browser_wait",
				description:
					"Wait until a ref/selector is visible, until `text` is visible, or until the URL matches `url` — bounded by `timeoutMs`.",
				parameters: BrowserWaitParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_wait: run context unavailable");
					try {
						return observationResult(
							await call(run.env, "POST", AGENT_BROWSER_WAIT_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.ref === undefined ? {} : { ref: args.ref }),
									...(args.selector === undefined
										? {}
										: { selector: args.selector }),
									...(args.text === undefined ? {} : { text: args.text }),
									...(args.url === undefined ? {} : { url: args.url }),
									...(args.observe === undefined
										? {}
										: { observe: args.observe }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_wait",
				description: [
					"Poll one condition *inside the server* until it holds or the bound elapses, and answer once — so a wait costs one tool call instead of one per poll.",
					"`until` takes exactly one of `text`, `selector`, `url` or `mail` (the last reads the stage's Mailpit mail catcher, by `to` and/or `subject`).",
					"The bound is the stage's `maxWaitSeconds`; `reload: true` re-opens the session's URL between polls.",
				].join(" "),
				parameters: StageWaitParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_wait: run context unavailable");
					const until = args.until as {
						text?: string;
						selector?: string;
						url?: string;
						mail?: { to?: string; subject?: string };
					};
					const named = [
						until.text !== undefined,
						until.selector !== undefined,
						until.url !== undefined,
						until.mail !== undefined,
					].filter(Boolean).length;
					if (named !== 1)
						return failure(
							"stage_wait: `until` takes exactly one of text, selector, url or mail",
						);
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_WAIT_PATH, {
								timeoutMs: STAGE_WAIT_TIMEOUT_MS,
								body: {
									until,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.reload === undefined ? {} : { reload: args.reload }),
									...(args.intervalSeconds === undefined
										? {}
										: { intervalSeconds: args.intervalSeconds }),
									...(args.timeoutSeconds === undefined
										? {}
										: { timeoutSeconds: args.timeoutSeconds }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_wait: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_step",
				description: [
					"Append one step to this workflow's journal, which becomes the `stage-flow.html` page the developer reads: the step, what it expected and observed, the values it captured, the evidence it shows, and what it taught about the process being tested.",
					"The server stamps the time, the session's application and role, the sanitized URL and — while a recording runs — the segment and the offset into it, so you never write a timestamp or a link yourself; everything is redacted on write.",
				].join(" "),
				parameters: StageStepParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_step: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_STEP_PATH, {
								timeoutMs: JOURNAL_TIMEOUT_MS,
								body: {
									label: args.label,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.expected === undefined
										? {}
										: { expected: args.expected }),
									...(args.observed === undefined
										? {}
										: { observed: args.observed }),
									...(args.captures === undefined
										? {}
										: { captures: args.captures }),
									...(args.evidence === undefined
										? {}
										: { evidence: args.evidence }),
									...(args.knowledge === undefined
										? {}
										: { knowledge: args.knowledge }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_step: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_journal",
				description:
					"Read the latest journal steps back (bounded by `limit`, optionally narrowed to one session or `app`), with the flow page's file name when there is one.",
				parameters: Type.Object({
					session: SessionParameter,
					app: Type.Optional(
						Type.String({
							description: "Only this application's steps.",
						}),
					),
					limit: Type.Optional(
						Type.Number({
							description: "How many of the newest steps to return (1–200).",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_journal: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_JOURNAL_PATH, {
								timeoutMs: JOURNAL_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.app === undefined ? {} : { app: args.app }),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_journal: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_blocks",
				description: [
					"List the reviewed, typed stage blocks this build can execute. The default list is compact (id, version, app, effects, title, roles, requires, provides); `roles: any` means the block is usable for every role. Pass one `id`, or `full: true`, for the postcondition, the parameter/return schema, validated examples, the source digest and — for a `kind: data` block — its operations, which is what you need to decide whether a block matches a route step, to run it or to adjust it.",
					"Use this instead of inventing browser steps from scratch: a plan step names exactly one block id and its JSON arguments. Filter by `app`, `effect` or `query` when the catalog is large.",
				].join(" "),
				parameters: StageBlocksParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_blocks: run context unavailable");
					try {
						return stageBlocksResult(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_BLOCKS_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.id === undefined ? {} : { id: args.id }),
									...(args.query === undefined ? {} : { query: args.query }),
									...(args.app === undefined ? {} : { app: args.app }),
									...(args.effect === undefined ? {} : { effect: args.effect }),
									...(args.full === undefined ? {} : { full: args.full }),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_blocks: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_run",
				description: [
					"Validate and execute a linear stage-block plan in one call and return a compact ledger; the journal (one entry per block sub-step) and evidence store hold the detail.",
					"Pass a standalone `{ planId?, flowId?, inputs?, steps }` plan; every step names a block and carries its own `args`. Call it with `dryRun: true` first: that resolves block versions and derives the typed input schema without opening a browser.",
					"Execution needs a stage-bound session and the same stage/write policy as the exploratory tools. Writes need a writable stage; destructive blocks are always refused. Inputs and arguments must never contain a credential: use the block's secret-variable names instead.",
					"A block you authored in this run is executable here once you have saved it, so you can prove the draft before your report claims it.",
					"`save: true` turns a plan with a `flowId` into a replayable flow. Anything you did not turn into a block stays in the journal and the report instead.",
				].join(" "),
				parameters: StageRunParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_run: run context unavailable");
					try {
						return stageRunResult(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_RUN_PATH, {
								timeoutMs: STAGE_RUN_TIMEOUT_MS,
								body: {
									plan: args.plan,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.stageApp === undefined
										? {}
										: { stageApp: args.stageApp }),
									...(args.role === undefined ? {} : { role: args.role }),
									...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
									...(args.save === undefined ? {} : { save: args.save }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_run: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_block_save",
				description: [
					"Save a stage block you found while exploring as a reviewed `format: 1` JSON document — a draft of this run. No builder step or code load is involved: a draft is executable by `stage_run` here and becomes shared when the developer approves the review report that lists it.",
					'Author from what the stage did: one `step` per intent, at least one `expectVisible`/`expectText`, `{{ args.<name> }}` for a declared parameter and `{ secret: "NAME" }` for a declared credential — never a literal credential, a raw URL, a script or an expression.',
					"The call is refused outside stage.execute, without a stage-bound session, for an application or role the stage does not declare, for a checked-in id, for a `destructive` effect, and for a `write` document on a read-only stage. A breaking change to an approved block needs a major version bump.",
				].join(" "),
				parameters: StageBlockSaveParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_block_save: run context unavailable");
					try {
						return stageBlockSaveResult(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_BLOCK_SAVE_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									document: args.document,
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_block_save: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_flows",
				description: [
					"List the checked-in compiled flows for this stage, with their route/spec hashes, applications, roles and input schema. It never opens a browser and never returns input values.",
					"Use it before `stage_replay` to choose a reviewed flow and see which inputs it accepts. A flow with a drifted spec or a block the registry disagrees with is refused by replay, not silently explored.",
				].join(" "),
				parameters: StageFlowsParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_flows: run context unavailable");
					try {
						return stageFlowsResult(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_FLOWS_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.stage === undefined ? {} : { stage: args.stage }),
									...(args.query === undefined ? {} : { query: args.query }),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_flows: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "stage_replay",
				description: [
					"Run one checked-in `@playwright/test` flow in a separate process, run a saved suite of independent flow entries, or list flows when both flowId and suiteId are omitted. The checked-in `flow.json` and the current block registry must still agree with each other; no plan approval is involved.",
					"Call `dryRun: true` first to validate the flow and a proposed input set without a browser. Without `inputs` the flow runs with its own recorded input example, and the answer states which values it used. Never put a secret in `inputs`.",
					"The server ingests the result's sub-step events into the normal stage journal and evidence store and returns a compact ledger and a heal packet on failure.",
					"A suiteId call runs every saved entry's own flow through that same gate and returns one aggregate ledger with a status per entry (passed, failed, refused or skipped).",
					"Never edit the block or spec from this tool. A failed replay returns the heal packet: fix it, or test that part with the exploratory tools and report what you found.",
				].join(" "),
				parameters: StageReplayParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_replay: run context unavailable");
					try {
						if (args.suiteId !== undefined)
							return stageSuiteResult(
								await call(run.env, "POST", AGENT_BROWSER_STAGE_REPLAY_PATH, {
									timeoutMs: STAGE_REPLAY_TIMEOUT_MS,
									body: {
										suiteId: args.suiteId,
										...(args.stage === undefined ? {} : { stage: args.stage }),
										...(args.dryRun === undefined
											? {}
											: { dryRun: args.dryRun }),
										...(args.role === undefined ? {} : { role: args.role }),
									},
								}),
							);
						if (args.flowId === undefined)
							return stageFlowsResult(
								await call(run.env, "POST", AGENT_BROWSER_STAGE_FLOWS_PATH, {
									timeoutMs: READ_TIMEOUT_MS,
									body: {
										...(args.stage === undefined ? {} : { stage: args.stage }),
									},
								}),
							);
						return stageReplayResult(
							await call(run.env, "POST", AGENT_BROWSER_STAGE_REPLAY_PATH, {
								timeoutMs: STAGE_REPLAY_TIMEOUT_MS,
								body: {
									flowId: args.flowId,
									...(args.stage === undefined ? {} : { stage: args.stage }),
									...(args.inputs === undefined ? {} : { inputs: args.inputs }),
									...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
									...(args.role === undefined ? {} : { role: args.role }),
								},
							}),
						);
					} catch (error) {
						return failure(`stage_replay: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_eval",
				description:
					"Evaluate JavaScript in the session's page and return the resolved value. Bounded by `timeoutMs`; the session stays usable afterwards.",
				parameters: BrowserEvalParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_eval: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_EVAL_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									code: args.code,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_eval: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_console",
				description:
					"Read this session's console and page-error history (bounded ring buffer), optionally filtered by `level` and `url`.",
				parameters: BrowserLogParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_console: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_CONSOLE_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: logBody(args),
							}),
						);
					} catch (error) {
						return failure(`browser_console: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_network",
				description:
					"Read this session's request history (bounded ring buffer) with method, URL, resource type, status and failure, optionally filtered by `status` and `url`.",
				parameters: BrowserLogParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_network: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_NETWORK_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: logBody(args),
							}),
						);
					} catch (error) {
						return failure(`browser_network: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_screenshot",
				description: [
					"Capture the session's page (or one element, by ref or selector) as a JPEG and return it to you as an image.",
					"`evidence: true` also stores it in this workflow's evidence store under `caption`, so the developer can review it; without it, only you see the image.",
					"`view: false` (with `evidence: true`) stores it without returning the image, which is how a long flow test documents its steps without filling your context with pictures.",
				].join(" "),
				parameters: BrowserScreenshotParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_screenshot: run context unavailable");
					try {
						const value = (await call(
							run.env,
							"POST",
							AGENT_BROWSER_SCREENSHOT_PATH,
							{
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.ref === undefined ? {} : { ref: args.ref }),
									...(args.selector === undefined
										? {}
										: { selector: args.selector }),
									...(args.fullPage === undefined
										? {}
										: { fullPage: args.fullPage }),
									...(args.evidence === undefined
										? {}
										: { evidence: args.evidence }),
									...(args.view === undefined ? {} : { view: args.view }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
								},
							},
						)) as {
							url?: string;
							mediaType?: string;
							base64?: string;
							evidence?: { id?: string; caption?: string };
						};
						// The caption comes back with the id: a `view: false` call answers
						// without the image, so the caption is the one thing that tells the
						// model which of its steps the stored screenshot belongs to (and it is
						// what the developer reads in the Evidence panel).
						const caption = value.evidence?.caption?.trim();
						const note = value.evidence?.id
							? `\nstored as evidence ${value.evidence.id}${caption === undefined || caption === "" ? "" : ` — ${caption}`}`
							: "\nstored as evidence: no (pass evidence: true to keep it)";
						const summary = `screenshot of ${value.url ?? "the page"}${note}`;
						// `view: false` answers with the evidence id alone, so no image block
						// is built for a picture this call deliberately did not look at.
						return value.base64 === undefined
							? { content: [{ type: "text", text: summary }] }
							: {
									content: [
										{ type: "text", text: summary },
										{
											type: "image",
											data: value.base64,
											mimeType: value.mediaType ?? "image/jpeg",
										},
									],
								};
					} catch (error) {
						return failure(`browser_screenshot: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_record_start",
				description:
					"Start recording a video of this session. It inherits the live page: cookies and storage carry over and the current URL is re-opened. A recording is capped at 10 minutes, then closed without being kept.",
				parameters: BrowserRecordParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_record_start: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_RECORD_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									action: "start",
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_record_start: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_record_stop",
				description:
					"Stop the recording. `keep: true` stores the WebM and its final-frame poster as evidence under `caption`; `keep: false` (the default) deletes both, leaving no file and no evidence entry.",
				parameters: BrowserRecordParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_record_stop: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_RECORD_PATH, {
								timeoutMs: RECORDING_TIMEOUT_MS,
								body: {
									action: "stop",
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.keep === undefined ? {} : { keep: args.keep }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_record_stop: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_run_script",
				description: [
					"Run Playwright JavaScript against this session's page with `(page, context, expect)`, bounded by `timeoutMs` (default 60s, max 10min).",
					"On timeout the tool fails with `script-timeout` and the session stays usable.",
					"`save: true` stores the code as a rerunnable `@playwright/test` spec (with the page URL pinned) in this workflow's evidence.",
					"`observe: true` returns the compact post-script delta and resulting snapshotId, so a deterministic batch does not need a separate snapshot call.",
					// The facade is an allow-list: naming it here is what keeps an agent from
					// discovering the surface by failing (`fix-env-tool-defects-from-e2e`).
					"`page` supports: goto, reload, goBack, goForward, url, title, content (truncated), setViewportSize, viewportSize, waitForLoadState, waitForURL, waitForSelector, waitForFunction, waitForTimeout, click, fill, press, selectOption, hover, textContent, innerText, inputValue, isVisible, isEnabled, screenshot, evaluate, locator, getByRole, getByText, getByLabel, getByPlaceholder, getByTestId, getByTitle, getByAltText, context(), keyboard, mouse.",
					"`context` supports: newPage, pages, cookies, addCookies, clearCookies, storageState, setDefaultTimeout, setDefaultNavigationTimeout, waitForTimeout; a locator supports the usual click/fill/press/waitFor/count/text reads and nested locator/getBy* builders.",
					"The handles are an allow-list facade, not a sandbox: a method outside the lists throws with the supported names in its message, and a result that would walk back to the shared browser (a `Response`, a `JSHandle`, another session's context) is refused.",
				].join(" "),
				parameters: BrowserScriptParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("browser_run_script: run context unavailable");
					try {
						const value = await call(
							run.env,
							"POST",
							AGENT_BROWSER_SCRIPT_PATH,
							{
								timeoutMs: RECORDING_TIMEOUT_MS,
								body: {
									code: args.code,
									...(args.session === undefined
										? {}
										: { session: args.session }),
									...(args.save === undefined ? {} : { save: args.save }),
									...(args.observe === undefined
										? {}
										: { observe: args.observe }),
									...(args.caption === undefined
										? {}
										: { caption: args.caption }),
									...(args.timeoutMs === undefined
										? {}
										: { timeoutMs: args.timeoutMs }),
								},
							},
						);
						return text(value);
					} catch (error) {
						return failure(`browser_run_script: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "browser_close",
				description:
					"Close one session and release its slot to whoever is waiting. Do this when you are done browsing: another workflow may be waiting for the session cap.",
				parameters: BrowserSessionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("browser_close: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_BROWSER_CLOSE_PATH, {
								timeoutMs: READ_TIMEOUT_MS,
								body: {
									...(args.session === undefined
										? {}
										: { session: args.session }),
								},
							}),
						);
					} catch (error) {
						return failure(`browser_close: ${message(error)}`);
					}
				},
			}),
		],
	});
}

/** The shared filter body of the two log reads. */
function logBody(args: {
	readonly session?: string;
	readonly level?: string;
	readonly status?: number;
	readonly url?: string;
	readonly limit?: number;
}): Record<string, unknown> {
	return {
		...(args.session === undefined ? {} : { session: args.session }),
		...(args.level === undefined ? {} : { level: args.level }),
		...(args.status === undefined ? {} : { status: args.status }),
		...(args.url === undefined ? {} : { url: args.url }),
		...(args.limit === undefined ? {} : { limit: args.limit }),
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
