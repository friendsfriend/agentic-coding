import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Config, text } from "../config.ts";
import { Refusal } from "../server/refusal.ts";

/** v1's task collection (Tasks tab). v2 keeps it in `CONFIG_DIR/tasks/`;
 * `CONFIG_DIR/scripts/` stays reserved for environment target dispatchers. */
export const tasksDirectory = (config: Config) =>
	path.join(config.configDir, "tasks");

export type TaskParameter = {
	name: string;
	type: string;
	required: boolean;
	description?: string;
	defaultValue?: string;
	choices?: string[];
	flag?: string;
};
type TaskFile = {
	name: string;
	relativePath: string;
	absolutePath: string;
	interpreter?: string;
	parameters?: TaskParameter[];
};
export type TaskNode = {
	name: string;
	relativePath: string;
	absolutePath: string;
	nodeType: "folder" | "script";
	interpreter?: string;
	parameters?: TaskParameter[];
	children?: TaskNode[];
};

/** Durable per-task argument history (v1 `addScriptArgsHistory`). */
export const TaskArgsHistory = defineDoc<{ entries: Record<string, string> }>({
	kind: "v2.task-args-history",
	version: 1,
	scope: "session",
	initial: () => ({ entries: {} }),
	checkpointWhen: () => true,
});

const metadataFlag = "--devenv-metadata",
	metadataTimeoutMs = 2000,
	listBudgetMs = 8000,
	maxTasks = 500,
	maxDepth = 8;
export const newTaskTemplate = `#!/usr/bin/env bash
# DevEnv metadata: run './script --devenv-metadata' to see the parameter schema.
# Example: uncomment and customize the lines below to declare parameters.
# # --- devenv-metadata ---
# echo '{"parameters":['
# echo '  {"name":"environment","type":"enum","required":true,"choices":["dev","test","prod"],"desc":"Target environment","flag":"--env"},'
# echo '  {"name":"dry-run","type":"bool","required":false,"desc":"Run without applying changes","flag":"--dry-run"}'
# echo ']}'
# exit 0
# # --- end metadata ---

set -euo pipefail

echo "Hello from your new DevEnv script"
`;

function interpreter(file: string) {
	try {
		const fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(256);
		const read = fs.readSync(fd, buffer, 0, 256, 0);
		fs.closeSync(fd);
		const line = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
		if (line.startsWith("#!")) {
			const parts = line.slice(2).trim().split(/\s+/).filter(Boolean);
			const base = path.basename(parts[0] ?? "");
			const name = base === "env" ? (parts[1] ?? "") : base;
			if (name) return name;
		}
	} catch {
		// Unreadable files are listed without an interpreter.
	}
	const extension = path.extname(file).toLowerCase();
	return (
		{
			".sh": "bash",
			".ps1": "pwsh",
			".py": "python",
			".ts": "bun",
			".js": "bun",
			".mjs": "bun",
			".rs": "rust-script",
		}[extension] ?? ""
	);
}
function parameter(raw: unknown): TaskParameter | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.name !== "string" || !value.name) return null;
	const string = (key: string) =>
		typeof value[key] === "string" && value[key]
			? String(value[key]).slice(0, 500)
			: undefined;
	const description = string("description") ?? string("desc"),
		defaultValue = string("defaultValue"),
		flag = string("flag");
	const choices = Array.isArray(value.choices)
		? value.choices
				.filter((choice): choice is string => typeof choice === "string")
				.slice(0, 100)
		: [];
	return {
		name: value.name.slice(0, 100),
		type: typeof value.type === "string" ? value.type.slice(0, 20) : "string",
		required: value.required === true,
		...(description ? { description } : {}),
		...(defaultValue ? { defaultValue } : {}),
		...(choices.length ? { choices } : {}),
		...(flag ? { flag } : {}),
	};
}
/** v1 metadata output: an array, `{parameters:[...]}` or one parameter. */
export function parseTaskMetadata(output: string): TaskParameter[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.trim());
	} catch {
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && "parameters" in parsed
			? (parsed as { parameters: unknown }).parameters
			: [parsed];
	return (Array.isArray(list) ? list : [])
		.map(parameter)
		.filter((item): item is TaskParameter => item !== null)
		.slice(0, 50);
}

/** Developer task collection: discovery, metadata, create/link/delete and
 * argument history. The developer's own direct TUI action is the approval;
 * agents and HTTP never reach it. Running a task stays a foreground TUI action
 * (v1); the server never executes a task, only its bounded metadata probe. */
export class TaskCollection {
	private cache = new Map<
		string,
		{ mtime: number; parameters: TaskParameter[] }
	>();
	constructor(
		private config: Config,
		private store: () => Harness,
	) {}
	private get root() {
		return tasksDirectory(this.config);
	}
	private realRoot() {
		fs.mkdirSync(this.root, { recursive: true, mode: 0o755 });
		return fs.realpathSync(this.root);
	}
	/** A target path relative to tasks/, never escaping it (v1 rules). */
	private target(raw: unknown, extension: string) {
		const value = text(raw, "task path", 512).replaceAll("\\", "/").trim();
		if (!value || value.startsWith("/") || path.isAbsolute(value))
			throw new Refusal("Task name/path must be relative to tasks/");
		const clean = path.posix.normalize(value);
		if (clean === "." || clean === ".." || clean.startsWith("../"))
			throw new Refusal("Task name/path cannot escape tasks/");
		if (clean.split("/").some((part) => part.startsWith(".")))
			throw new Refusal(
				"Task name/path segments in tasks/ cannot start with a dot",
			);
		const relativePath =
			extension && !path.posix.extname(clean) ? `${clean}${extension}` : clean;
		const root = this.realRoot(),
			absolutePath = path.join(root, ...relativePath.split("/"));
		// Every existing ancestor must stay inside the real tasks directory.
		let existing = path.dirname(absolutePath);
		while (!fs.existsSync(existing)) existing = path.dirname(existing);
		const real = fs.realpathSync(existing);
		if (real !== root && !real.startsWith(`${root}${path.sep}`))
			throw new Refusal("Task name/path cannot escape tasks/");
		return { relativePath, absolutePath };
	}
	private discover(): TaskFile[] {
		const root = this.root,
			result: TaskFile[] = [];
		if (!fs.existsSync(root)) return result;
		const walk = (directory: string, depth: number) => {
			if (depth > maxDepth || result.length >= maxTasks) return;
			for (const entry of fs
				.readdirSync(directory, { withFileTypes: true })
				.sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.startsWith(".")) continue;
				const full = path.join(directory, entry.name);
				// Never follow a symlinked directory out of (or around) tasks/.
				if (entry.isDirectory()) {
					walk(full, depth + 1);
					continue;
				}
				let stat: fs.Stats;
				try {
					stat = fs.statSync(full);
				} catch {
					continue;
				}
				if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
				if (result.length >= maxTasks) return;
				result.push({
					name: entry.name,
					relativePath: path.relative(root, full).split(path.sep).join("/"),
					absolutePath: full,
					interpreter: interpreter(full),
				});
			}
		};
		walk(root, 0);
		return result;
	}
	private find(relativePath: unknown) {
		const value = text(relativePath, "task path", 512).replace(/^\/+/, "");
		const found = this.discover().find((task) => task.relativePath === value);
		if (!found) throw new Refusal("Task not found");
		return found;
	}
	/** `<task> --devenv-metadata` in its own process group with a minimal
	 * environment (no configuration secrets), 2 s deadline, 64 KiB stdout. */
	private async probe(file: string): Promise<TaskParameter[]> {
		let mtime: number;
		try {
			mtime = fs.statSync(file).mtimeMs;
		} catch {
			return [];
		}
		const cached = this.cache.get(file);
		if (cached?.mtime === mtime) return cached.parameters;
		const output = await new Promise<string>((resolve) => {
			let stdout = "",
				done = false;
			const child = spawn(file, [metadataFlag], {
				cwd: path.dirname(file),
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
				env: Object.fromEntries(
					["PATH", "HOME", "LANG", "TMPDIR", "TERM"].flatMap((key) =>
						process.env[key] ? [[key, process.env[key]]] : [],
					),
				),
			});
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					// The group already exited.
				}
				resolve(stdout);
			};
			const timer = setTimeout(finish, metadataTimeoutMs);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				if (stdout.length > 65536) {
					stdout = "";
					finish();
				}
			});
			child.on("error", finish);
			child.on("close", finish);
		});
		const parameters = parseTaskMetadata(output);
		this.cache.set(file, { mtime, parameters });
		return parameters;
	}
	/** v1 tree: folders first, then tasks. Metadata probes are bounded to 10
	 * at a time and an overall budget; unprobed tasks show no parameters until
	 * their args modal reads metadata. */
	async list(): Promise<TaskNode[]> {
		const files = this.discover(),
			deadline = Date.now() + listBudgetMs;
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(10, files.length) }, async () => {
				while (next < files.length && Date.now() < deadline) {
					const file = files[next++];
					if (file) file.parameters = await this.probe(file.absolutePath);
				}
			}),
		);
		return tree(this.root, files);
	}
	async metadata(relativePath: unknown) {
		return {
			parameters: await this.probe(this.find(relativePath).absolutePath),
		};
	}
	create(targetPath: unknown) {
		const { relativePath, absolutePath } = this.target(targetPath, ".sh");
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o755 });
		try {
			fs.writeFileSync(absolutePath, newTaskTemplate, {
				mode: 0o755,
				flag: "wx",
			});
		} catch {
			throw new Refusal("Target task already exists");
		}
		return { success: true, operation: "create", relativePath, absolutePath };
	}
	link(targetPath: unknown, sourcePath: unknown) {
		const source = path.resolve(text(sourcePath, "source task path", 4096));
		let stat: fs.Stats;
		try {
			stat = fs.statSync(source);
		} catch {
			throw new Refusal("Source task path does not exist");
		}
		if (!stat.isFile()) throw new Refusal("Source task path must be a file");
		const extension = path.extname(source).toLowerCase();
		if (!extension) throw new Refusal("Source task must have an extension");
		const { relativePath, absolutePath } = this.target(targetPath, extension);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o755 });
		try {
			fs.symlinkSync(source, absolutePath);
		} catch {
			throw new Refusal("Target task already exists");
		}
		return { success: true, operation: "link", relativePath, absolutePath };
	}
	/** Removes one task or folder inside tasks/; a symlink is unlinked, never
	 * followed. */
	remove(target: unknown) {
		const { relativePath, absolutePath } = this.target(target, "");
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(absolutePath);
		} catch {
			throw new Refusal("Task target does not exist");
		}
		if (stat.isDirectory())
			fs.rmSync(absolutePath, { recursive: true, force: true });
		else fs.unlinkSync(absolutePath);
		return { success: true, operation: "delete", relativePath, absolutePath };
	}
	async history(relativePath: unknown, limit: unknown = 50) {
		const key = text(relativePath, "task path", 512),
			count =
				Number.isSafeInteger(limit) && Number(limit) > 0
					? Math.min(Number(limit), 200)
					: 50,
			doc = await this.store().snapshot(TaskArgsHistory, background),
			raw = doc?.entries[key];
		return {
			relativePath: key,
			entries: (raw ? (JSON.parse(raw) as Record<string, string>[]) : []).slice(
				0,
				count,
			),
		};
	}
	async addHistory(relativePath: unknown, raw: unknown) {
		const key = text(relativePath, "task path", 512);
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Refusal("Task argument values must be an object");
		const values = Object.fromEntries(
			Object.entries(raw as Record<string, unknown>)
				.slice(0, 50)
				.map(([name, value]) => [
					name.slice(0, 100),
					text(String(value ?? ""), "task argument", 2000),
				]),
		);
		await this.store().commit(async (tx) => {
			const doc = await tx.doc(TaskArgsHistory),
				existing = doc.entries[key]
					? (JSON.parse(doc.entries[key]) as Record<string, string>[])
					: [],
				serialized = JSON.stringify(values);
			doc.entries[key] = JSON.stringify(
				[
					values,
					...existing.filter((entry) => JSON.stringify(entry) !== serialized),
				].slice(0, 50),
			);
		}, background);
		return { success: true };
	}
}

function tree(root: string, files: TaskFile[]): TaskNode[] {
	type Folder = {
		folders: Map<string, Folder>;
		tasks: TaskNode[];
		node: TaskNode;
	};
	const top: Folder = {
		folders: new Map(),
		tasks: [],
		node: {
			name: "",
			relativePath: "",
			absolutePath: root,
			nodeType: "folder",
		},
	};
	for (const file of files) {
		const parts = file.relativePath.split("/");
		let cursor = top,
			prefix = "";
		for (const part of parts.slice(0, -1)) {
			prefix = prefix ? `${prefix}/${part}` : part;
			let child = cursor.folders.get(part);
			if (!child) {
				child = {
					folders: new Map(),
					tasks: [],
					node: {
						name: part,
						relativePath: prefix,
						absolutePath: path.join(root, ...prefix.split("/")),
						nodeType: "folder",
					},
				};
				cursor.folders.set(part, child);
			}
			cursor = child;
		}
		cursor.tasks.push({
			name: file.name,
			relativePath: file.relativePath,
			absolutePath: file.absolutePath,
			nodeType: "script",
			...(file.interpreter ? { interpreter: file.interpreter } : {}),
			...(file.parameters?.length ? { parameters: file.parameters } : {}),
		});
	}
	const nodes = (folder: Folder): TaskNode[] => [
		...[...folder.folders.keys()].sort().map((name) => {
			const child = folder.folders.get(name) as Folder;
			return { ...child.node, children: nodes(child) };
		}),
		...folder.tasks,
	];
	return nodes(top);
}
