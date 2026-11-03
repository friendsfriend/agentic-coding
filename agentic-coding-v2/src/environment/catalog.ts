import fs from "node:fs";
import path from "node:path";
import { type Config, object, text } from "../config.ts";
import { contained } from "../git.ts";
import type { TaskInfo } from "../state.ts";

export type Action = "run" | "build" | "test";
export type Target = {
	id: string;
	action: Action;
	runtime: "shell";
	command: string;
	cwd: string;
	timeoutMs: number;
	readyText: string | null;
	environment: Record<string, string>;
	secretRefs: Record<string, string>;
};
export type Project = {
	id: string;
	kind: "app" | "library";
	repository: string;
	targets: Target[];
};
export type Plan = Target & { app: string; workspace: string; cwd: string };
const identifier = (value: unknown) => {
	const id = text(value, "environment identifier", 64);
	if (!/^[a-z][a-z0-9-]*$/.test(id))
		throw new Error("Invalid environment identifier");
	return id;
};
function variables(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(object(value ?? {})).map(([key, value]) => {
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
				["WORKSPACE", "CONFIG_DIR"].includes(key)
			)
				throw new Error("Invalid or reserved environment variable name");
			if (
				typeof value !== "string" ||
				value.includes("\0") ||
				value.length > 16000
			)
				throw new Error("Invalid environment variable mapping");
			return [key, value];
		}),
	);
}
function keysOnly(data: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unsupported environment configuration field; check the v2 schema (legacy definitions are not loaded)",
		);
}
function readTarget(raw: unknown): Target {
	const data = object(raw);
	keysOnly(data, [
		"id",
		"action",
		"runtime",
		"command",
		"cwd",
		"timeoutMs",
		"readyText",
		"environment",
		"secretRefs",
	]);
	if (data.runtime !== "shell")
		throw new Error(
			"Only shell environment targets are supported in this migration slice",
		);
	if (!["run", "build", "test"].includes(String(data.action)))
		throw new Error("Invalid environment target action");
	const timeoutMs = data.timeoutMs ?? (data.action === "run" ? 30000 : 600000);
	if (
		!Number.isSafeInteger(timeoutMs) ||
		Number(timeoutMs) < 100 ||
		Number(timeoutMs) > 3600000
	)
		throw new Error("Invalid environment timeoutMs");
	const environment = variables(data.environment),
		secretRefs = variables(data.secretRefs);
	if (Object.keys(environment).some((key) => key in secretRefs))
		throw new Error(
			"Environment variable has both a literal and secret reference",
		);
	for (const ref of Object.values(secretRefs))
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
			throw new Error("Invalid environment secret reference");
	const cwd = text(data.cwd ?? ".", "environment cwd", 4096);
	if (path.isAbsolute(cwd))
		throw new Error("Environment cwd must be relative to the task workspace");
	return {
		id: identifier(data.id),
		action: data.action as Action,
		runtime: "shell",
		command: text(data.command, "environment command", 16000),
		cwd,
		timeoutMs: Number(timeoutMs),
		readyText:
			data.readyText === undefined
				? null
				: text(data.readyText, "readiness text", 512),
		environment,
		secretRefs,
	};
}
export function loadProjects(config: Config): Project[] {
	const file = path.join(config.configDir, "environments.json");
	if (!fs.existsSync(file)) return [];
	let data: Record<string, unknown>;
	try {
		data = object(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		throw new Error(
			`Invalid environment configuration: ${file}; values are not logged`,
		);
	}
	keysOnly(data, ["version", "projects"]);
	if (data.version !== 1 || !Array.isArray(data.projects))
		throw new Error(
			"Environment configuration needs version 1 and a projects array",
		);
	const projects = data.projects.map((raw): Project => {
		const entry = object(raw);
		keysOnly(entry, ["id", "kind", "repository", "targets"]);
		if (
			!["app", "library"].includes(String(entry.kind)) ||
			!Array.isArray(entry.targets)
		)
			throw new Error("Environment project needs kind app/library and targets");
		const repository = fs.realpathSync(
			text(entry.repository, "environment repository", 4096),
		);
		if (!config.repositories.includes(repository))
			throw new Error(
				"Environment repository is not authorized by application configuration",
			);
		const targets = entry.targets.map(readTarget);
		if (new Set(targets.map((target) => target.id)).size !== targets.length)
			throw new Error("Duplicate environment target ID");
		if (
			entry.kind === "library" &&
			targets.some((target) => target.action === "run")
		)
			throw new Error("Libraries cannot have run targets");
		return {
			id: identifier(entry.id),
			kind: entry.kind as Project["kind"],
			repository,
			targets,
		};
	});
	if (new Set(projects.map((project) => project.id)).size !== projects.length)
		throw new Error("Duplicate environment project ID");
	return projects;
}
export function resolvePlans(
	projects: Project[],
	owner: TaskInfo,
	apps: string[],
	action: Action,
	target?: string,
): Plan[] {
	if (owner.policy !== "workspace-write")
		throw new Error(
			"Environment execution requires a workspace-write task and separate human approval",
		);
	if (!apps.length || apps.length > 16 || new Set(apps).size !== apps.length)
		throw new Error("Choose 1–16 distinct environment apps");
	return apps.map((app) => {
		const project = projects.find((project) => project.id === app);
		if (!project || project.repository !== owner.repository)
			throw new Error(
				"Environment project must belong to this task's repository",
			);
		const candidates = project.targets.filter(
			(item) =>
				item.action === action && (target === undefined || item.id === target),
		);
		if (candidates.length !== 1)
			throw new Error(`Choose an unambiguous ${action} target for ${app}`);
		const chosen = candidates[0];
		if (!chosen) throw new Error("Environment target missing");
		const cwd = contained(owner.workspace, chosen.cwd);
		if (!fs.statSync(cwd).isDirectory())
			throw new Error(
				"Environment cwd must be an existing task workspace directory",
			);
		return { ...chosen, app, workspace: owner.workspace, cwd };
	});
}
