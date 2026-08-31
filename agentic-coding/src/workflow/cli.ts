import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Herdr } from "../herdr-client.ts";
import {
	type AgentAdapter,
	HerdrLifecycle,
	type HerdrPort,
	OpenCodeAdapter,
	OpenCodeV2Adapter,
	PiAdapter,
} from "./adapters.ts";
import { manageAgentExtension } from "./agent-extensions.ts";
import type { CredentialPrompt } from "./credentials.ts";
import { definitionVersionForPolicy, registerBuiltins } from "./definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
	resolveLiveAgent,
} from "./effect-runner.ts";
import { loadConfig } from "./effects.ts";
import {
	parseAgentsConfig,
	preflightProfile,
	resolvePreset,
	resolveProfile,
	resolveRouting,
	validatePresetCoverage,
} from "./profiles.ts";
import {
	QUESTION_WAIT_MS,
	validateChangeId,
	WorkflowEngine,
	wikiWorkflowDataRoot,
	wikiWorkflowTarget,
} from "./runtime.ts";
import {
	appendLog,
	ensureBundle,
	listConcepts,
	readConcept,
	searchConcepts,
	verifyConcept,
	wikiRoot,
	writeConcept,
} from "./wiki.ts";

export const SUBCOMMANDS: readonly string[] = [
	"start",
	"status",
	"action",
	"handoff",
	"question",
	"repair",
	"repin",
	"projects",
	"config",
	"agent-extension",
	"wiki",
] as const;
export const REQUIRED_FLAGS: Record<string, string[]> = {
	start: ["repo", "change", "mode"],
	status: ["repo", "change"],
	action: ["repo", "change", "revision"],
	repair: ["repo", "change", "revision", "step"],
	repin: ["repo", "change"],
	handoff: ["outcome"],
	question: ["description"],
};
export const AGENT_EXTENSION_SUBCOMMANDS = [
	"list",
	"install",
	"install-local",
] as const;
export const WIKI_SUBCOMMANDS = [
	"list",
	"search",
	"show",
	"write",
	"verify",
	"log",
] as const;
export const PLUGIN_SUBCOMMANDS = AGENT_EXTENSION_SUBCOMMANDS;
const registry = registerBuiltins(
	undefined,
	loadConfig().workflow.max_verification_rounds,
);
export function engine(): WorkflowEngine {
	return new WorkflowEngine(registry);
}
/**
 * Allocates the pane a run launches into. Reuse-before-spawn is authoritative:
 * persistent roles adopt the live agent's resolved pane and a new tab is
 * created only when no live agent resolves; grouped triage/verification rounds
 * keep their split geometry but anchor on siblings confirmed live through the
 * canonical-name resolver instead of raw stored pane ids.
 */
export function paneForRunFactory(
	workflowEngine: WorkflowEngine,
	repo: string,
	herdr: HerdrPort,
): (runId: string) => Promise<{ paneId: string; tabId?: string }> {
	return async (runId) => {
		const run = workflowEngine.getRun(repo, runId);
		const snapshot = workflowEngine.getSnapshot(repo, run.workflowId);
		if (!snapshot.metadata.workspace)
			throw new Error("workflow workspace unavailable");
		const roundScoped = ["core.triage", "core.verification"].includes(
			run.stepId,
		);
		// Adopt any live agent's pane instead of spawning a duplicate; fall
		// through to geometry or tab creation only when no agent resolves.
		const resolved = resolveLiveAgent(
			herdr,
			snapshot.metadata.changeId,
			snapshot.definition.id,
			run,
		);
		if (resolved) return { paneId: resolved.paneId };
		if (roundScoped) {
			const round = workflowEngine
				.status(repo, snapshot.metadata.changeId)
				.runs.map((item) => workflowEngine.getRun(repo, item.id))
				.filter(
					(item) =>
						["core.triage", "core.verification"].includes(item.stepId) &&
						item.attempt === run.attempt &&
						!["expired", "failed"].includes(item.status),
				); // rowid order = launch order; a createdAt/id tiebreak shuffles same-ms runs
			const { k, n } = verificationPosition(round, run.id);
			const all = round.filter((item) => item.id !== run.id);
			const bottomPane = (anchor: string): string | undefined => {
				try {
					const layout = herdr.call("pane", "layout", "--pane", anchor) as {
						layout?: {
							panes?: Array<{ pane_id?: string; rect?: { y?: number } }>;
						};
					};
					const panes = layout.layout?.panes ?? [];
					return [...panes]
						.filter((pane) => pane.pane_id !== anchor)
						.sort((a, b) => (b.rect?.y ?? 0) - (a.rect?.y ?? 0))[0]?.pane_id;
				} catch {
					return undefined;
				}
			};
			const split = (target: string, direction: "right" | "down") => {
				try {
					const result = herdr.call(
						"pane",
						"split",
						target,
						"--direction",
						direction,
						"--ratio",
						"0.5",
					) as { pane?: { pane_id?: string; tab_id?: string } };
					return result.pane?.pane_id
						? {
								paneId: result.pane.pane_id,
								...(result.pane.tab_id ? { tabId: result.pane.tab_id } : {}),
							}
						: undefined;
				} catch {
					return undefined;
				}
			};
			if (n >= 2) {
				// Siblings anchor by identity: resolve each live through the same
				// canonical-name resolver as every other launch path.
				const resolvedSiblings = new Map<string, string>();
				for (const sibling of all) {
					const resolved = resolveLiveAgent(
						herdr,
						snapshot.metadata.changeId,
						snapshot.definition.id,
						sibling,
					);
					if (resolved) resolvedSiblings.set(sibling.id, resolved.paneId);
				}
				let anchor: string | undefined;
				for (const sibling of all) {
					const pane = resolvedSiblings.get(sibling.id);
					if (pane) {
						anchor = pane;
						break;
					}
				}
				if (anchor) {
					if (k === 2) {
						if (n >= 3) split(anchor, "down");
						const placed = split(anchor, "right");
						if (placed) return placed;
					} else if (k === 3) {
						// bottom full-width row was created with the second pane; reuse it, or create it now if the second launch was retried
						const spare = bottomPane(anchor);
						if (spare) return { paneId: spare };
						const placed = split(anchor, "down");
						if (placed) return placed;
					} else if (k === 4) {
						const bottom = bottomPane(anchor);
						if (bottom) {
							const placed = split(bottom, "right");
							if (placed) return placed;
						}
						const placed = split(anchor, "down");
						if (placed) return placed;
					} else {
						const nextSibling = all[k - 3];
						const target =
							(nextSibling
								? resolvedSiblings.get(nextSibling.id)
								: undefined) ??
							bottomPane(anchor) ??
							anchor;
						if (target) {
							const placed = split(target, "down");
							if (placed) return placed;
						}
					}
				}
			}
		}
		const label = roundScoped ? "verification" : run.role;
		const result = herdr.call(
			"tab",
			"create",
			"--workspace",
			snapshot.metadata.workspace,
			"--cwd",
			snapshot.metadata.worktree,
			"--label",
			label,
		) as { root_pane?: { pane_id?: string; tab_id?: string } };
		if (!result.root_pane?.pane_id)
			throw new Error("Herdr tab create returned no pane");
		return {
			paneId: result.root_pane.pane_id,
			...(result.root_pane.tab_id ? { tabId: result.root_pane.tab_id } : {}),
		};
	};
}

export async function drainEffects(
	workflowEngine: WorkflowEngine,
	repo: string,
	credentialPrompt?: CredentialPrompt,
): Promise<void> {
	const config = loadConfig();
	const herdr = new Herdr();
	const lifecycle = new HerdrLifecycle(herdr);
	const adapters = new Map<string, AgentAdapter>([
		["pi", new PiAdapter(lifecycle)],
		["opencode", new OpenCodeAdapter(lifecycle)],
		["opencode-v2", new OpenCodeV2Adapter(lifecycle)],
	]);
	const handlers = agentEffectHandlers(repo, workflowEngine, {
		registry,
		adapters,
		herdr,
		remote: config.workflow.remote,
		prTool: config.workflow.pr_tool,
		credentialPrompt,
		paneForRun: paneForRunFactory(workflowEngine, repo, herdr),
	});
	await new EffectRunner(repo, workflowEngine, handlers).drain();
}

function requireFlag(argv: string[], name: string): string {
	const value = flag(argv, name);
	if (value === undefined) throw new Error(`missing required flag --${name}`);
	return value;
}
function flag(argv: string[], name: string): string | undefined {
	const exact = argv.indexOf(`--${name}`);
	if (exact !== -1) return argv[exact + 1];
	const prefix = `--${name}=`;
	return argv.find((token) => token.startsWith(prefix))?.slice(prefix.length);
}
type CallerEnvironment = Record<string, string>;
function processEnvironment(pid: number): CallerEnvironment {
	return Object.fromEntries(
		fs
			.readFileSync(`/proc/${pid}/environ`)
			.toString()
			.split("\0")
			.flatMap((entry) => {
				const separator = entry.indexOf("=");
				return separator > 0
					? [[entry.slice(0, separator), entry.slice(separator + 1)]]
					: [];
			}),
	);
}
function parentProcessId(pid: number): number | undefined {
	if (process.platform !== "linux") {
		const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid="], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error("managed caller ancestry is unavailable");
		const parent = Number(result.stdout.toString().trim());
		if (!Number.isInteger(parent) || parent < 0)
			throw new Error("managed caller ancestry is malformed");
		return parent === 0 ? undefined : parent;
	}
	let stat: string;
	try {
		stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		// Process entries can disappear while walking ancestry.
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const parent = Number(fields[1]);
	if (!Number.isInteger(parent) || parent < 0)
		throw new Error("managed caller ancestry is malformed");
	return parent === 0 ? undefined : parent;
}
function processCommand(pid: number): string {
	const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error("managed caller ancestry is unavailable");
	return result.stdout.toString().trim();
}
function managedProcessAncestor(): boolean {
	const seen = new Set<number>();
	let pid = process.ppid;
	while (pid > 1 && !seen.has(pid)) {
		seen.add(pid);
		if (
			/(?:^|[\\s/])(pi|opencode|opencode2|opencode-v2)(?:[\\s]|$)/i.test(
				processCommand(pid),
			)
		)
			return true;
		const parent = parentProcessId(pid);
		if (parent === undefined) return false;
		pid = parent;
	}
	if (seen.has(pid)) throw new Error("managed caller ancestry is cyclic");
	return false;
}
/** Read the launch environment from the caller's process ancestry. A child
 * cannot bypass the managed-agent boundary by unsetting its own environment. */
function callerEnvironment(): CallerEnvironment {
	const local = process.env as CallerEnvironment;
	if (process.platform !== "linux") {
		// A managed run always carries these values in the current process. If a
		// child clears them, identify the managed runtime through its ancestry;
		// never infer interactivity from the current working directory.
		if (local.HERDR_RUN_TOKEN || local.HERDR_WORKFLOW_ID) return local;
		if (managedProcessAncestor())
			throw new Error("managed caller ancestry is unavailable");
		return {};
	}
	let managed: CallerEnvironment = {};
	let managedPid: number | undefined;
	const seen = new Set<number>();
	let pid = process.pid;
	let rootReached = false;
	while (!seen.has(pid)) {
		seen.add(pid);
		// PID 1 is the process-tree root in the host namespace; its environment
		// is not needed to establish the managed ancestor and may be unreadable.
		let environment: CallerEnvironment;
		try {
			environment =
				pid === process.pid ? local : pid === 1 ? {} : processEnvironment(pid);
		} catch {
			if (managedPid !== undefined) {
				rootReached = true;
				break;
			}
			throw new Error("managed caller ancestry is unavailable");
		}
		if (
			pid !== process.pid &&
			(environment.HERDR_RUN_TOKEN || environment.HERDR_WORKFLOW_ID)
		) {
			managed = environment;
			managedPid = pid;
		}
		const parent = parentProcessId(pid);
		if (parent === undefined) {
			rootReached = true;
			break;
		}
		pid = parent;
	}
	if (!rootReached) throw new Error("managed caller ancestry is cyclic");
	if (local.HERDR_RUN_TOKEN || local.HERDR_WORKFLOW_ID) {
		if (managedPid === undefined)
			throw new Error("managed caller ancestry is unavailable");
	}
	return managed;
}
function resolveHandoffIdentity(
	workflowEngine: WorkflowEngine,
	repo: string,
	overrideEnvironment?: CallerEnvironment,
): {
	runId: string;
	generation: number;
	token: string;
	workflowId: string;
	stepId: string;
	role: string;
	outputPath?: string;
} {
	const environment = overrideEnvironment ?? callerEnvironment();
	const workflowId = environment.HERDR_WORKFLOW_ID;
	const stepId = environment.HERDR_STEP_ID;
	const role = environment.HERDR_ROLE;
	const runId = environment.HERDR_RUN_ID;
	let token = environment.HERDR_RUN_TOKEN;
	if (!workflowId || !stepId || !role || !runId)
		throw new Error(
			"handoff requires an exact launch-bound run environment and capability",
		);
	const callerRun = workflowEngine.getRun(repo, runId);
	let run = callerRun;
	try {
		workflowEngine.authorizeExactRunCapability(
			repo,
			workflowId,
			runId,
			stepId,
			role,
			token ?? "",
		);
	} catch {
		// Persistent agents keep the original environment when their pane is
		// reused. Only adopt the current generation when the immutable caller
		// run and current run resolve to the same live pane; never select by
		// mutable role identity alone.
		const current = workflowEngine.activeRunForRole(
			repo,
			workflowId,
			stepId,
			role,
		);
		if (
			!callerRun.handle?.paneId ||
			!current.handle?.paneId ||
			callerRun.handle.paneId !== current.handle.paneId
		)
			throw new Error("invalid or inactive run capability");
		const currentSnapshot = workflowEngine.getSnapshot(repo, workflowId);
		const envFile = path.join(
			repo === wikiWorkflowTarget()
				? path.join(wikiWorkflowDataRoot(), currentSnapshot.metadata.changeId)
				: path.join(repo, ".herdr-workflow"),
			"runtime-bin",
			current.id,
			"run.env",
		);
		const line = fs
			.readFileSync(envFile, "utf8")
			.split("\n")
			.find((item) => item.startsWith("HERDR_RUN_TOKEN="));
		const refreshedToken = line?.slice("HERDR_RUN_TOKEN=".length);
		if (!refreshedToken)
			throw new Error("persistent agent run capability is unavailable");
		token = refreshedToken;
		run = workflowEngine.authorizeExactRunCapability(
			repo,
			workflowId,
			current.id,
			stepId,
			role,
			refreshedToken,
		);
	}
	return {
		runId: run.id,
		generation: run.generation,
		token: token ?? "",
		workflowId,
		stepId,
		role,
		...(run.outputPath ? { outputPath: run.outputPath } : {}),
	};
}
function positionals(argv: string[]): string[] {
	const values: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) values.push(token);
		else if (!token.includes("=") && !["--clean", "--confirm"].includes(token))
			i++;
	}
	return values;
}
function positional(argv: string[]): string | undefined {
	return positionals(argv)[0];
}
function parseMode(value: string | undefined): "worktree" | "checkout" {
	if (value !== "worktree" && value !== "checkout")
		throw new Error("start: --mode must be worktree or checkout");
	return value;
}
/** Ordered 2–5 profile list for plan-fusion's planner fan-out, following the
 * existing single-flag convention: comma-separated names, order = role order. */
export function parseFusionProfiles(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length < 2 || names.length > 5)
		throw new Error(
			"plan-fusion: --fusion-profiles requires 2-5 comma-separated profile names",
		);
	if (new Set(names).size !== names.length)
		throw new Error("plan-fusion: duplicate profile in --fusion-profiles");
	return names;
}
function required(command: string, argv: string[]): void {
	for (const name of REQUIRED_FLAGS[command] ?? [])
		if (flag(argv, name) === undefined)
			throw new Error(`${command}: --${name} is required`);
}
const FLAG_SCHEMA: Record<
	string,
	{ values: string[]; booleans?: string[]; positionals: [number, number] }
> = {
	start: {
		values: [
			"repo",
			"change",
			"mode",
			"workflow",
			"task",
			"ticket",
			"preset",
			"fusion-profiles",
		],
		positionals: [0, 0],
	},
	status: { values: ["repo", "change"], positionals: [0, 0] },
	action: {
		values: ["repo", "change", "revision", "input"],
		positionals: [1, 1],
	},
	handoff: {
		values: ["outcome", "artifact", "message"],
		booleans: ["no-drain"],
		positionals: [0, 0],
	},
	question: {
		values: ["description", "options", "timeout"],
		positionals: [0, 0],
	},
	repair: {
		values: ["repo", "change", "revision", "step", "reason"],
		booleans: ["confirm"],
		positionals: [0, 0],
	},
	repin: { values: ["repo", "change", "revision"], positionals: [0, 0] },
	projects: { values: [], positionals: [0, 0] },
	config: { values: [], positionals: [0, 0] },
	"agent-extension": { values: ["profile"], positionals: [1, 2] },
	wiki: {
		values: [
			"tag",
			"type",
			"title",
			"description",
			"limit",
			"path",
			"body-file",
			"tags",
			"resource",
			"status",
			"stale-after",
			"source",
			"actor",
			"entry",
			"generated-by",
			"verified",
		],
		booleans: ["json"],
		positionals: [0, 100],
	},
};
function validateArgs(command: string, argv: string[]): void {
	const schema = FLAG_SCHEMA[command];
	const seen = new Set<string>();
	let positionalCount = 0;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			positionalCount++;
			continue;
		}
		const [rawName = "", inline] = token.slice(2).split("=", 2);
		if (!schema.values.includes(rawName) && !schema.booleans?.includes(rawName))
			throw new Error(`${command}: unknown flag --${rawName}`);
		if (seen.has(rawName))
			throw new Error(`${command}: duplicate flag --${rawName}`);
		seen.add(rawName);
		if (schema.booleans?.includes(rawName)) {
			if (inline !== undefined)
				throw new Error(`${command}: --${rawName} does not take a value`);
			continue;
		}
		if (inline !== undefined) {
			if (!inline) throw new Error(`${command}: --${rawName} requires a value`);
			continue;
		}
		const value = argv[++i];
		if (!value || value.startsWith("--"))
			throw new Error(`${command}: --${rawName} requires a value`);
	}
	if (positionalCount < schema.positionals[0])
		throw new Error(
			command === "action"
				? "action: ACTION_ID is required"
				: `${command}: missing required positional argument`,
		);
	if (positionalCount > schema.positionals[1])
		throw new Error(`${command}: unexpected positional argument`);
}
function help(command?: string): void {
	if (!command) {
		console.log(
			"Usage: agentic-coding workflow <command> [flags]\n\nCommands:\n  start            Start pinned workflow definition\n  status           Print validated workflow view\n  action           Dispatch revision-bound engine action\n  handoff          Submit run-bound agent outcome\n  question         Ask the developer a bounded question\n  repair           Repair to compatible step, retriggers phase\n  repin            Re-pin to current definition digest\n  projects         List configured projects\n  config           Print resolved configuration\n  agent-extension  Manage Pi agent extensions\n  wiki             Read/update OKF wiki; only the managed wiki role may write drafts; archive verifies",
		);
		return;
	}
	const usage: Record<string, string> = {
		start:
			"start --repo PATH --change ID --mode worktree|checkout [--workflow standard|standard-propose|direct-apply|no-openspec|plan-fusion|fusion-propose|wiki-only] [--fusion-profiles NAME,NAME,...] [--task TEXT] [--ticket ID] [--preset NAME]",
		status: "status --repo PATH --change ID",
		action:
			"action ACTION_ID --repo PATH --change ID --revision N [--input JSON_OR_PATH]",
		handoff:
			"handoff --outcome complete|blocked|failed [--artifact PATH] [--message TEXT]",
		question:
			"question --description TEXT [--options JSON] [--timeout MILLISECONDS]",
		repair:
			"repair --repo PATH --change ID --revision N --step STEP [--reason TEXT] [--confirm]",
		projects: "projects",
		config: "config",
		"agent-extension":
			"agent-extension list|install SOURCE|install-local PATH [--profile NAME]",
		wiki: "wiki list|search TERMS|show ID|write --path ID --type T --title T --description D|verify --path ID [--actor A]|log --entry TEXT [--path DIR]",
	};
	console.log(`Usage: agentic-coding workflow ${usage[command] ?? command}`);
}
function parseInput(value?: string): unknown {
	if (!value) return undefined;
	const text = fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("--input must be JSON or path to JSON");
	}
}
export function runGit(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			(result.stderr.toString() || result.stdout.toString()).trim(),
		);
	return result.stdout.toString().trim();
}
export function validateQuestionTimeout(timeoutMs: number): void {
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > QUESTION_WAIT_MS
	)
		throw new Error(
			`question timeout must be an integer from 1 to ${QUESTION_WAIT_MS}`,
		);
}

export async function runDeveloperQuestion(
	engineInstance: WorkflowEngine,
	repo: string,
	description: string,
	options: unknown = [],
	timeoutMs = QUESTION_WAIT_MS,
): Promise<string> {
	if (!description.trim())
		throw new Error("question requires a non-empty description");
	validateQuestionTimeout(timeoutMs);
	const identity = resolveHandoffIdentity(engineInstance, repo);
	const run = engineInstance.authorizeExactRunCapability(
		repo,
		identity.workflowId,
		identity.runId,
		identity.stepId,
		identity.role,
		identity.token,
	);
	const created = engineInstance.dispatch(repo, {
		type: "agent.question",
		workflowId: run.workflowId,
		runId: run.id,
		stepId: run.stepId,
		role: run.role,
		token: identity.token,
		description,
		options,
	});
	const questionId = created.snapshot.developerDialogue.at(-1)?.id;
	if (!questionId) throw new Error("question was not recorded");
	const deadline = Date.now() + timeoutMs;
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	process.on("SIGTERM", interrupt);
	process.on("SIGINT", interrupt);
	try {
		while (!interrupted && Date.now() < deadline) {
			const question = engineInstance
				.getSnapshot(repo, run.workflowId)
				.developerDialogue.find((item) => item.id === questionId);
			if (!question)
				throw new Error("question disappeared from workflow state");
			if (question.status !== "pending") return JSON.stringify(question);
			await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
		}
		try {
			engineInstance.dispatch(repo, {
				type: "agent.question-expire",
				workflowId: run.workflowId,
				questionId,
				runId: run.id,
				stepId: run.stepId,
				role: run.role,
				token: identity.token,
			});
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/no longer pending|expired/.test(error.message)
			)
				throw error;
		}
		const expired = engineInstance
			.getSnapshot(repo, run.workflowId)
			.developerDialogue.find((item) => item.id === questionId);
		return JSON.stringify(expired ?? { status: "expired", id: questionId });
	} finally {
		process.off("SIGTERM", interrupt);
		process.off("SIGINT", interrupt);
	}
}

export function validateStart(
	repo: string,
	change: string,
	workflow: string,
	task?: string,
): void {
	const dirty = runGit(repo, "status", "--porcelain");
	const proposal = ["standard-propose", "fusion-propose"].includes(workflow);
	if (workflow === "wiki-only") {
		if (!task?.trim())
			throw new Error("wiki-only workflow requires non-empty --task");
		return;
	}
	if (dirty && !proposal)
		throw new Error("working tree must be clean before workflow start");
	if (workflow === "no-openspec") {
		if (!task?.trim())
			throw new Error("no-openspec workflow requires non-empty --task");
		return;
	}
	if (!fs.existsSync(path.join(repo, "openspec", "config.yaml")))
		throw new Error("OpenSpec project required for this workflow");
	if (workflow === "direct-apply") {
		const root = path.join(repo, "openspec", "changes", change);
		const requiredFiles = ["proposal.md", "design.md", "tasks.md"];
		for (const file of requiredFiles)
			if (
				!fs.existsSync(path.join(root, file)) ||
				!fs.readFileSync(path.join(root, file), "utf8").trim()
			)
				throw new Error(`invalid direct-apply artifact: ${file}`);
		const specs = path.join(root, "specs");
		if (
			!fs.existsSync(specs) ||
			!findFiles(specs).some((file) =>
				/#### Scenario:/.test(fs.readFileSync(file, "utf8")),
			)
		)
			throw new Error("direct-apply requires at least one OpenSpec scenario");
		if (!/\[ \]/.test(fs.readFileSync(path.join(root, "tasks.md"), "utf8")))
			throw new Error("direct-apply requires actionable unchecked task");
		const result = Bun.spawnSync(["openspec", "validate", change, "--strict"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error(
				`OpenSpec validation failed: ${(result.stderr.toString() || result.stdout.toString()).trim()}`,
			);
	}
}
function findFiles(root: string): string[] {
	const result: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...findFiles(file));
		else result.push(file);
	}
	return result;
}
export function listProjects(): Array<{
	name: string;
	path: string;
	openspec: boolean;
}> {
	const config = loadConfig().projects;
	const root = path.resolve(String(config.root).replace(/^~/, os.homedir()));
	const found: Array<{ name: string; path: string; openspec: boolean }> = [];
	const walk = (directory: string, depth: number) => {
		if (depth > config.max_depth) return;
		try {
			if (!fs.existsSync(directory)) return;
			if (fs.existsSync(path.join(directory, ".git"))) {
				found.push({
					name: path.relative(root, directory) || ".",
					path: directory,
					openspec: fs.existsSync(
						path.join(directory, "openspec", "config.yaml"),
					),
				});
				return;
			}
			for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
				if (
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					!["node_modules", "dist", "build", "target"].includes(entry.name)
				)
					walk(path.join(directory, entry.name), depth + 1);
		} catch {
			return;
		}
	};
	walk(root, 0);
	return found.sort((a, b) => a.name.localeCompare(b.name));
}
/** Agent roles per step for a built-in definition. The plan-fusion fan-out
 * derives one planner role per entry of the ordered profile list. */
export function rolesForDefinition(
	definitionId: string,
	steps: readonly string[],
	registry: { step(id: string): { actor: string } },
	fusionPlannerCount = 0,
): Record<string, string[]> {
	const roles: Record<string, string[]> = {};
	for (const stepId of steps) {
		if (registry.step(stepId).actor !== "agent") continue;
		roles[stepId] =
			stepId === "core.plan"
				? ["planner"]
				: stepId === "fusion.plan"
					? Array.from(
							{ length: fusionPlannerCount },
							(_, index) => `planner-${index + 1}`,
						)
					: stepId === "fusion.consolidate"
						? ["consolidator"]
						: stepId === "core.implementation"
							? ["worker"]
							: stepId === "core.triage"
								? ["triage"]
								: stepId === "core.verification"
									? [
											"quality-verifier",
											"security-verifier",
											"performance-verifier",
											"openspec-verifier",
											"usability-verifier",
											"test-verifier",
										].filter(
											(role) =>
												definitionId !== "no-openspec" ||
												role !== "openspec-verifier",
										)
									: stepId === "core.wiki"
										? ["wiki"]
										: stepId === "core.archive"
											? ["archive"]
											: [];
	}
	return roles;
}
function samePath(left: string, right: string): boolean {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
function wikiRole(): string | undefined {
	return process.env.HERDR_ROLE || undefined;
}
function managedWorkflowTarget(fallback = process.cwd()): string {
	return process.env.HERDR_WORKFLOW_TARGET === wikiWorkflowTarget()
		? wikiWorkflowTarget()
		: fallback;
}
function managedAgent(): boolean {
	try {
		const environment = callerEnvironment();
		return Boolean(
			environment.HERDR_RUN_TOKEN ||
				environment.HERDR_WORKFLOW_ID ||
				environment.HERDR_STEP_ID,
		);
	} catch {
		// If ancestry cannot be authenticated, fail closed as managed.
		return true;
	}
}
function authorizeWikiWriter(): ReturnType<WorkflowEngine["getSnapshot"]> {
	const workflowId = process.env.HERDR_WORKFLOW_ID;
	const stepId = process.env.HERDR_STEP_ID;
	const role = process.env.HERDR_ROLE;
	const token = process.env.HERDR_RUN_TOKEN;
	if (!workflowId || stepId !== "core.wiki" || role !== "wiki" || !token)
		throw new Error("wiki write requires an authenticated core.wiki run");
	const workflowEngine = engine();
	const target =
		process.env.HERDR_WORKFLOW_TARGET === wikiWorkflowTarget()
			? wikiWorkflowTarget()
			: process.cwd();
	workflowEngine.authorizeAgentCapability(
		target,
		workflowId,
		stepId,
		role,
		token,
	);
	const snapshot = workflowEngine.getSnapshot(target, workflowId);
	const pinnedRoot = path.resolve(snapshot.metadata.wikiRoot ?? wikiRoot(true));
	if (!samePath(wikiRoot(), pinnedRoot))
		throw new Error(
			"wiki write destination does not match the pinned workflow wiki root",
		);
	return snapshot;
}
function wikiActor(role: string | undefined): string {
	return role
		? `herdr-${role}/${process.env.HERDR_PROFILE || "default"}`
		: "human:developer";
}
function wikiOutput(rest: string[], value: unknown): void {
	console.log(
		JSON.stringify(value, null, rest.includes("--json") ? 2 : undefined),
	);
}
async function runWiki(rest: string[]): Promise<void> {
	const [operation, ...terms] = positionals(rest);
	if (
		!operation ||
		!(WIKI_SUBCOMMANDS as readonly string[]).includes(operation)
	)
		throw new Error(
			`unknown wiki command: ${operation ?? "(none)"}; usage: agentic-coding workflow wiki list|search|show|write|verify|log`,
		);
	const role = wikiRole();
	if (operation === "list") {
		wikiOutput(
			rest,
			listConcepts({ tag: flag(rest, "tag"), type: flag(rest, "type") }),
		);
		return;
	}
	if (operation === "search") {
		if (!terms.length)
			throw new Error(
				"wiki search requires TERMS; usage: wiki search TERMS [--limit N]",
			);
		const rawLimit = flag(rest, "limit");
		const limit = rawLimit === undefined ? 20 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("wiki search --limit must be an integer from 1 to 1000");
		wikiOutput(rest, searchConcepts(terms, limit));
		return;
	}
	if (operation === "show") {
		if (!terms[0])
			throw new Error("wiki show requires a concept id; usage: wiki show ID");
		wikiOutput(rest, readConcept(terms[0]));
		return;
	}
	if (operation === "write") {
		// Preserve the explicitly supported unmanaged administrative path when
		// no managed identity is present. This is the selected compatibility
		// trade-off for hosts where managed ancestry may be detectable without
		// workflow variables.
		if (
			!role &&
			managedAgent() &&
			(process.env.HERDR_RUN_TOKEN ||
				process.env.HERDR_WORKFLOW_ID ||
				process.env.HERDR_STEP_ID)
		)
			throw new Error("wiki write requires an authenticated workflow role");
		if (role && role !== "wiki")
			throw new Error(`wiki write is not permitted for role ${role}`);
		const authorizedSnapshot =
			role === "wiki" ? authorizeWikiWriter() : undefined;
		const concept = flag(rest, "path");
		const type = flag(rest, "type");
		const title = flag(rest, "title");
		const description = flag(rest, "description");
		if (!concept || !type || !title || !description)
			throw new Error(
				"wiki write requires --path, --type, --title, and --description; usage: wiki write --path ID --type T --title T --description D",
			);
		if (authorizedSnapshot?.definition.id === "wiki-comment-review") {
			const context = authorizedSnapshot.step.context;
			const comments =
				context && typeof context === "object" && !Array.isArray(context)
					? (context as { comments?: unknown }).comments
					: undefined;
			const permitted = new Set(
				Array.isArray(comments)
					? comments.flatMap((item) =>
							item && typeof item === "object" && "conceptId" in item
								? [String((item as { conceptId: unknown }).conceptId)]
								: [],
						)
					: [],
			);
			if (!permitted.has(concept.replaceAll("\\", "/").replace(/\.md$/, "")))
				throw new Error("wiki write is outside the submitted comment scope");
		}
		const requestedStatus = flag(rest, "status");
		const requestedVerified = flag(rest, "verified");
		const requestedActor = flag(rest, "generated-by");
		if (
			role &&
			(requestedActor?.startsWith("human:") ||
				requestedVerified?.startsWith("human:"))
		)
			throw new Error(
				"human-reviewed tier is granted only by the approval gate",
			);
		if (requestedStatus === "stable" || requestedVerified)
			throw new Error(
				"stable or verified wiki metadata is granted only by the approval gate",
			);
		const resources = [flag(rest, "resource"), flag(rest, "source")].filter(
			(value): value is string => Boolean(value),
		);
		const bodyFile = flag(rest, "body-file");
		wikiOutput(
			rest,
			writeConcept(concept, {
				type,
				title,
				description,
				...(flag(rest, "tags")
					? {
							tags: flag(rest, "tags")
								?.split(",")
								.map((tag) => tag.trim())
								.filter(Boolean),
						}
					: {}),
				...(resources.length
					? { sources: resources.map((resource) => ({ resource })) }
					: {}),
				status: role ? "draft" : requestedStatus,
				...(flag(rest, "stale-after")
					? { stale_after: flag(rest, "stale-after") }
					: {}),
				...(bodyFile ? { body: fs.readFileSync(bodyFile, "utf8") } : {}),
				generatedBy: requestedActor ?? wikiActor(role),
				...(requestedVerified
					? {
							verified: [
								{ by: requestedVerified, at: new Date().toISOString() },
							],
						}
					: {}),
				changeId: process.env.HERDR_CHANGE_ID,
			}),
		);
		return;
	}
	if (operation === "verify") {
		if (
			!role &&
			managedAgent() &&
			(process.env.HERDR_RUN_TOKEN ||
				process.env.HERDR_WORKFLOW_ID ||
				process.env.HERDR_STEP_ID)
		)
			throw new Error(
				"wiki verify requires the archive role or an interactive caller",
			);
		if (role && role !== "archive")
			throw new Error("wiki verify is archive-only");
		const concept = flag(rest, "path");
		if (!concept)
			throw new Error(
				"wiki verify requires --path ID; usage: wiki verify --path ID",
			);
		const verifyingActor = flag(rest, "actor") ?? "process:herdr-archive";
		if (verifyingActor !== "process:herdr-archive")
			throw new Error(
				"wiki verify requires process:herdr-archive; human promotion requires the approval gate",
			);
		wikiOutput(rest, verifyConcept(concept, verifyingActor));
		return;
	}
	if (
		!role &&
		managedAgent() &&
		(process.env.HERDR_RUN_TOKEN ||
			process.env.HERDR_WORKFLOW_ID ||
			process.env.HERDR_STEP_ID)
	)
		throw new Error(
			"wiki log requires the archive role or an interactive caller",
		);
	if (role && role !== "archive") throw new Error("wiki log is archive-only");
	const entry = flag(rest, "entry");
	if (!entry)
		throw new Error(
			"wiki log requires --entry TEXT; usage: wiki log --entry TEXT [--path DIR]",
		);
	wikiOutput(rest, {
		path: appendLog(flag(rest, "path") ?? ensureBundle(), entry),
	});
}

export async function run(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	if (!command || ["help", "--help", "-h"].includes(command)) {
		help();
		return;
	}
	if (!(SUBCOMMANDS as readonly string[]).includes(command))
		throw new Error(`unknown command: ${command}`);
	if (rest.includes("--help") || rest.includes("-h")) {
		help(command);
		return;
	}
	validateArgs(command, rest);
	required(command, rest);
	if (command === "wiki") {
		await runWiki(rest);
		return;
	}
	const workflowEngine = engine();
	if (command === "config") {
		console.log(JSON.stringify(loadConfig(), null, 2));
		return;
	}
	if (command === "projects") {
		console.log(JSON.stringify(listProjects()));
		return;
	}
	if (command === "start") {
		const repo = fs.realpathSync(path.resolve(requireFlag(rest, "repo")));
		const change = validateChangeId(requireFlag(rest, "change"));
		const mode = parseMode(flag(rest, "mode"));
		const workflow = flag(rest, "workflow") ?? "standard";
		const proposal = ["standard-propose", "fusion-propose"].includes(workflow);
		const sameCheckout = proposal || workflow === "wiki-only";
		if (
			![
				"standard",
				"standard-propose",
				"direct-apply",
				"no-openspec",
				"plan-fusion",
				"fusion-propose",
				"wiki-only",
			].includes(workflow)
		)
			throw new Error(`unknown workflow definition: ${workflow}`);
		if (sameCheckout && mode !== "checkout")
			throw new Error("repository-backed workflows require --mode checkout");
		const fusionProfiles =
			workflow === "plan-fusion" || workflow === "fusion-propose"
				? parseFusionProfiles(flag(rest, "fusion-profiles"))
				: undefined;
		const task = flag(rest, "task");
		validateStart(repo, change, workflow, task);
		const config = loadConfig();
		const definitionVersion = definitionVersionForPolicy(
			config.workflow.max_verification_rounds,
		);
		const definition = registry.definition(workflow, definitionVersion);
		const agents = parseAgentsConfig(config.agents, config);
		const roles = rolesForDefinition(
			definition.id,
			definition.steps,
			registry,
			fusionProfiles?.length ?? 0,
		);
		const presetName = flag(rest, "preset");
		const preset = presetName ? resolvePreset(agents, presetName) : undefined;
		if (preset)
			validatePresetCoverage(preset, definition, Object.keys(roles), agents);
		const routing = resolveRouting(definition, roles, agents, preset);
		if (fusionProfiles) {
			// Explicit per-task model list overrides preset/config resolution for
			// the planner fan-out; position i binds to role planner-i.
			for (const [index, name] of fusionProfiles.entries()) {
				const route = routing.routes.find(
					(item) =>
						item.stepId === "fusion.plan" &&
						item.role === `planner-${index + 1}`,
				);
				if (!route)
					throw new Error(`missing fusion planner route planner-${index + 1}`);
				route.profile = resolveProfile(name, agents);
			}
		}
		for (const route of routing.routes)
			preflightProfile(route.profile, registry.step(route.stepId).requirements);
		const baseBranch = config.workflow.base_branch;
		const baseCommit = sameCheckout
			? runGit(repo, "rev-parse", "HEAD")
			: runGit(repo, "rev-parse", `${baseBranch}^{commit}`);
		if (!sameCheckout)
			runGit(repo, "remote", "get-url", config.workflow.remote);
		const branch = sameCheckout
			? runGit(repo, "branch", "--show-current")
			: `${config.workflow.branch_prefix}${change}`;
		if (sameCheckout && !branch)
			throw new Error(
				"repository-backed workflows require a named current branch",
			);
		workflowEngine.start({
			repo,
			mode,
			sameCheckout,
			changeId: change,
			definitionId: workflow,
			definitionVersion,
			metadata: {
				branch,
				baseBranch,
				baseCommit,
				...(task?.trim() ? { task: task.trim() } : {}),
				...(flag(rest, "ticket")
					? { ticket: requireFlag(rest, "ticket") }
					: {}),
			},
			routing,
		});
		await drainEffects(workflowEngine, repo);
		console.log(JSON.stringify(workflowEngine.status(repo, change), null, 2));
		return;
	}
	const repo = flag(rest, "repo") ?? process.cwd();
	if (command === "status") {
		await drainEffects(workflowEngine, repo);
		console.log(
			JSON.stringify(
				workflowEngine.status(repo, requireFlag(rest, "change")),
				null,
				2,
			),
		);
		return;
	}
	if (command === "action") {
		if (managedAgent())
			throw new Error(
				"developer actions require the interactive developer channel",
			);
		const actions = positionals(rest);
		if (actions.length !== 1 || !actions[0]?.trim())
			throw new Error(
				actions.length > 1
					? "action: unexpected positional argument"
					: "action: ACTION_ID is required",
			);
		const view = workflowEngine.status(repo, requireFlag(rest, "change"));
		workflowEngine.dispatch(repo, {
			type: "developer.action",
			workflowId: view.workflowId,
			revision: Number(flag(rest, "revision")),
			actionId: actions[0],
			input: parseInput(flag(rest, "input")),
		});
		await drainEffects(workflowEngine, repo);
		console.log(
			JSON.stringify(
				workflowEngine.status(repo, requireFlag(rest, "change")),
				null,
				2,
			),
		);
		return;
	}
	if (command === "question") {
		if (!managedAgent())
			throw new Error("question requires an authenticated managed agent");
		const description = requireFlag(rest, "description");
		const options = flag(rest, "options")
			? parseInput(flag(rest, "options"))
			: [];
		const timeout = flag(rest, "timeout");
		const timeoutMs =
			timeout === undefined ? QUESTION_WAIT_MS : Number(timeout);
		console.log(
			await runDeveloperQuestion(
				workflowEngine,
				managedWorkflowTarget(),
				description,
				options,
				timeoutMs,
			),
		);
		return;
	}
	if (command === "handoff") {
		const outcome = flag(rest, "outcome");
		if (
			outcome === undefined ||
			!["complete", "blocked", "failed"].includes(outcome)
		)
			throw new Error("handoff: invalid --outcome");
		const target = managedWorkflowTarget();
		const identity = resolveHandoffIdentity(workflowEngine, target);
		const artifact = identity.outputPath ?? flag(rest, "artifact");
		const result = workflowEngine.dispatch(target, {
			type: "agent.handoff",
			runId: identity.runId,
			generation: identity.generation,
			token: identity.token,
			outcome,
			...(artifact ? { artifact } : {}),
			...(flag(rest, "message") ? { message: flag(rest, "message") } : {}),
		});
		if (!rest.includes("--no-drain"))
			await drainEffects(workflowEngine, target);
		else {
			const entry = Bun.main.startsWith("$bunfs") ? undefined : Bun.main;
			const drain = Bun.spawn(
				detachedDrainArgv(entry, target, result.view.changeId),
				{
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
					cwd: process.cwd(),
					env: process.env,
				},
			);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && drain.exitCode === null)
				Bun.sleepSync(50);
			if (drain.exitCode !== null && drain.exitCode !== 0)
				console.error(
					`detached drain exited early (${drain.exitCode}); run status to drain pending effects`,
				);
			drain.unref();
		}
		console.log(
			JSON.stringify(
				workflowEngine.status(target, result.view.changeId),
				null,
				2,
			),
		);
		return;
	}
	if (command === "repair") {
		if (!rest.includes("--confirm")) {
			console.log(
				JSON.stringify(
					workflowEngine.previewRepair(repo, requireFlag(rest, "change")),
					null,
					2,
				),
			);
			return;
		}
		const view = workflowEngine.status(repo, requireFlag(rest, "change"));
		workflowEngine.dispatch(repo, {
			type: "operator.repair",
			workflowId: view.workflowId,
			revision: Number(flag(rest, "revision")),
			targetStep: flag(rest, "step"),
			reason: flag(rest, "reason") ?? "",
		});
		await drainEffects(workflowEngine, repo);
		console.log(
			JSON.stringify(
				workflowEngine.status(repo, requireFlag(rest, "change")),
				null,
				2,
			),
		);
		return;
	}
	if (command === "repin") {
		const view = workflowEngine.status(repo, requireFlag(rest, "change"));
		const revision =
			flag(rest, "revision") === undefined
				? view.revision
				: Number(flag(rest, "revision"));
		workflowEngine.dispatch(repo, {
			type: "operator.repin",
			workflowId: view.workflowId,
			revision,
		});
		await drainEffects(workflowEngine, repo);
		console.log(
			JSON.stringify(
				workflowEngine.status(repo, requireFlag(rest, "change")),
				null,
				2,
			),
		);
		return;
	}
	if (command === "agent-extension") {
		const [subcommand, ...args] = rest;
		if (
			!(AGENT_EXTENSION_SUBCOMMANDS as readonly string[]).includes(subcommand)
		)
			throw new Error(
				`unknown agent-extension command: ${subcommand ?? "(none)"}`,
			);
		const profiles: string[] = [];
		for (let index = 0; index < args.length; index++) {
			if (args[index] !== "--profile") continue;
			const next = args[index + 1];
			if (next !== undefined) profiles.push(next);
		}
		if (subcommand === "list") manageAgentExtension({ command: "list" });
		else if (subcommand === "install")
			manageAgentExtension({
				command: "install",
				source: positional(args),
				profiles,
			});
		else
			manageAgentExtension({
				command: "install-local",
				source: positional(args),
				profiles,
			});
	}
}
export function detachedDrainArgv(
	entry: string | undefined,
	repo: string,
	change: string,
): string[] {
	return [
		process.execPath,
		...(entry ? [entry] : []),
		"workflow",
		"status",
		"--repo",
		repo,
		"--change",
		change,
	];
}

export function verificationPosition(
	round: Array<{ id: string }>,
	runId: string,
): { k: number; n: number } {
	const k = round.findIndex((item) => item.id === runId) + 1;
	return { k, n: round.length };
}
export const cliTest = {
	flag,
	parseMode,
	positionals,
	requirePositional: (argv: string[]) => {
		const value = positional(argv);
		if (!value) throw new Error("missing positional argument");
		return value;
	},
	detachedDrainArgv,
	verificationPosition,
	validateQuestionTimeout,
	resolveHandoffIdentity: (workflowEngine: WorkflowEngine, repo: string) =>
		resolveHandoffIdentity(
			workflowEngine,
			repo,
			process.env as CallerEnvironment,
		),
};
export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<void> {
	try {
		await run(argv);
	} catch (error) {
		console.error((error as Error).message ?? String(error));
		process.exitCode = 1;
	}
}
