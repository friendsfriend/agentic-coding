import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directories = [
	path.join(os.homedir(), ".pi", "agent", "extensions"),
	path.join(os.homedir(), ".config", "pi", "extensions"),
];
const assignmentsPath = path.join(
	os.homedir(),
	".pi",
	"agent",
	"agent-extension-assignments.json",
);
interface Assignments {
	extensions: Array<{ source: string; profiles: string[] }>;
}
export function loadAssignments(): Assignments {
	try {
		const value = JSON.parse(
			fs.readFileSync(assignmentsPath, "utf8"),
		) as Assignments;
		return Array.isArray(value.extensions) ? value : { extensions: [] };
	} catch {
		const legacy = path.join(
			os.homedir(),
			".pi",
			"agent",
			"plugin-assignments.json",
		);
		try {
			const value = JSON.parse(fs.readFileSync(legacy, "utf8")) as {
				plugins?: Array<{ source?: string; agentRoles?: string[] }>;
			};
			const migrated = {
				extensions: (value.plugins ?? []).flatMap((item) =>
					item.source &&
					(item.agentRoles ?? []).every((role) =>
						["worker", "planner"].includes(role),
					)
						? [{ source: item.source, profiles: ["pi-default"] }]
						: [],
				),
			};
			if (migrated.extensions.length) saveAssignments(migrated);
			return migrated;
		} catch {
			return { extensions: [] };
		}
	}
}
function saveAssignments(value: Assignments): void {
	fs.mkdirSync(path.dirname(assignmentsPath), { recursive: true });
	fs.writeFileSync(assignmentsPath, `${JSON.stringify(value, null, 2)}\n`);
}
function discover(): Record<string, string> {
	const found: Record<string, string> = {};
	for (const directory of directories) {
		if (!fs.existsSync(directory)) continue;
		for (const entry of fs.readdirSync(directory).sort())
			if (/\.(?:js|mjs|ts)$/.test(entry))
				found[path.basename(entry, path.extname(entry))] ??= path.join(
					directory,
					entry,
				);
	}
	return found;
}
export interface AgentExtensionArgs {
	command: "list" | "install" | "install-local";
	source?: string;
	profiles?: string[];
}
export function manageAgentExtension(args: AgentExtensionArgs): void {
	if (args.command === "list") {
		const assigned = loadAssignments();
		console.log(
			JSON.stringify(
				Object.entries(discover()).map(([name, file]) => ({
					name,
					file,
					profiles:
						assigned.extensions.find(
							(item) =>
								path.basename(item.source, path.extname(item.source)) === name,
						)?.profiles ?? [],
				})),
				null,
				2,
			),
		);
		return;
	}
	if (!args.source)
		throw new Error(`agent-extension ${args.command} requires source`);
	if (args.command === "install") {
		const result = Bun.spawnSync(["pi", "install", args.source], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error(
				`pi install failed: ${(result.stderr.toString() || result.stdout.toString()).trim()}`,
			);
	} else {
		const source = fs.realpathSync(
			path.resolve(args.source.replace(/^~/, os.homedir())),
		);
		const directory = directories[0];
		if (!directory)
			throw new Error("no agent extension directories configured");
		const target = path.join(directory, path.basename(source));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(source, target);
	}
	const profiles = [...new Set(args.profiles ?? [])];
	if (profiles.length) {
		const value = loadAssignments();
		const existing = value.extensions.find(
			(item) => item.source === args.source,
		);
		if (existing)
			existing.profiles = [...new Set([...existing.profiles, ...profiles])];
		else value.extensions.push({ source: args.source, profiles });
		saveAssignments(value);
	}
}
