// The command-name lookup table that replaces the former `run(argv)` branch
// chain, plus the process entrypoint (`main`) and the test-only helper
// bundle (`cliTest`). Moved out of cli.ts (split-workflow-god-modules) —
// every command's own logic now lives under `cli/commands/*.ts` and the
// shared `cli/*.ts` helpers; this file only parses argv, resolves shared
// context, and dispatches.
import { loadConfig } from "../effects.ts";
import type { WorkflowEngine } from "../runtime.ts";
import { flag, positional, positionals, requireFlag } from "./args.ts";
import type { CallerEnvironment } from "./caller-environment.ts";
import {
	runAction,
	runHandoff,
	runQuestion,
	validateQuestionTimeout,
} from "./commands/dispatch-actions.ts";
import {
	listProjects,
	runAgentExtension,
	runRepair,
	runRepin,
} from "./commands/misc.ts";
import { runResearchHandoff } from "./commands/research-handoff.ts";
import { parseMode, runStart } from "./commands/start.ts";
import { runWiki } from "./commands/wiki.ts";
import { detachedDrainArgv, drainEffects } from "./drain.ts";
import { help } from "./help.ts";
import { resolveHandoffIdentity } from "./identity.ts";
import { verificationPosition } from "./pane.ts";
import { engine } from "./registry.ts";
import { required, SUBCOMMANDS, validateArgs } from "./schema.ts";

async function runStatus(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
): Promise<void> {
	await drainEffects(workflowEngine, repo);
	console.log(
		JSON.stringify(
			workflowEngine.status(repo, requireFlag(rest, "workflow-id")),
			null,
			2,
		),
	);
}

type CommandHandler = (
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
) => Promise<void> | void;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
	start: (rest, workflowEngine) => runStart(rest, workflowEngine),
	status: runStatus,
	action: runAction,
	question: (rest, workflowEngine) => runQuestion(rest, workflowEngine),
	"research-handoff": (rest, workflowEngine) =>
		runResearchHandoff(rest, workflowEngine),
	handoff: (rest, workflowEngine) => runHandoff(rest, workflowEngine),
	repair: runRepair,
	repin: runRepin,
	"agent-extension": (rest) => runAgentExtension(rest),
};

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
	const repo = flag(rest, "repo") ?? process.cwd();
	const handler = COMMAND_HANDLERS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	await handler(rest, workflowEngine, repo);
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
