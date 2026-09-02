// Command surface declarations: the subcommand list, per-command required
// flags, subcommand vocabularies, and the flag/positional-argument schema
// validator. Moved verbatim out of cli.ts (split-workflow-god-modules).
import { flag } from "./args.ts";

export const SUBCOMMANDS: readonly string[] = [
	"start",
	"status",
	"action",
	"handoff",
	"question",
	"research-handoff",
	"repair",
	"repin",
	"projects",
	"config",
	"agent-extension",
	"wiki",
] as const;
export const REQUIRED_FLAGS: Record<string, string[]> = {
	start: ["workflow-id"],
	status: ["repo", "workflow-id"],
	action: ["repo", "workflow-id", "revision"],
	repair: ["repo", "workflow-id", "revision", "step"],
	repin: ["repo", "workflow-id"],
	handoff: ["outcome"],
	question: ["description"],
	"research-handoff": ["subject", "directives"],
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

export function required(command: string, argv: string[]): void {
	for (const name of REQUIRED_FLAGS[command] ?? [])
		if (
			flag(argv, name) === undefined &&
			!(command === "question" && flag(argv, "questions") !== undefined)
		)
			throw new Error(`${command}: --${name} is required`);
}
const FLAG_SCHEMA: Record<
	string,
	{ values: string[]; booleans?: string[]; positionals: [number, number] }
> = {
	start: {
		values: [
			"repo",
			"workflow-id",
			"mode",
			"workflow",
			"task",
			"ticket",
			"preset",
			"fusion-profiles",
		],
		positionals: [0, 0],
	},
	status: { values: ["repo", "workflow-id"], positionals: [0, 0] },
	action: {
		values: ["repo", "workflow-id", "revision", "input"],
		positionals: [1, 1],
	},
	handoff: {
		values: ["outcome", "artifact", "message"],
		booleans: ["no-drain"],
		positionals: [0, 0],
	},
	question: {
		values: ["description", "context", "options", "questions", "timeout"],
		positionals: [0, 0],
	},
	"research-handoff": {
		values: ["subject", "target", "findings", "citations", "directives"],
		booleans: ["no-sources"],
		positionals: [0, 0],
	},
	repair: {
		values: ["repo", "workflow-id", "revision", "step", "reason"],
		booleans: ["confirm"],
		positionals: [0, 0],
	},
	repin: { values: ["repo", "workflow-id", "revision"], positionals: [0, 0] },
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
		booleans: ["json", "confirm"],
		positionals: [0, 100],
	},
};
export function validateArgs(command: string, argv: string[]): void {
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
