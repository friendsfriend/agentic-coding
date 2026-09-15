// Script discovery, mutation, metadata and interpreter selection
// (`port-action-execution-to-bun`, tasks 3.1, 3.2 and 3.4).
//
// Ported from `server/pkg/resources/{scripts,shell_actions}.go`,
// `server/pkg/server/{handlers_scripts,script_actions}.go` and
// `server/pkg/server/script_metadata_process_unix.go`.
//
// Everything here is filesystem behaviour, so the module takes paths as
// parameters and never resolves a home directory itself. Three rules are worth
// stating because they are easy to lose in a port:
//
//   - a *target* path is always relative to `scripts/` and can never escape it,
//   - discovery is by executable bit on POSIX and by shebang/extension on
//     Windows, and the interpreter is the shebang or the extension fallback,
//   - metadata comes from running the script with `--devenv-metadata` under a
//     two-second deadline whose timeout kills the whole process tree.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { killProcessTree } from "./process-group.ts";

export type ScriptParameterType = "string" | "int" | "bool" | "enum";

export interface ScriptParameter {
	name: string;
	/** Declared type; a script may use a value outside the editor's union. */
	type: string;
	/** Always present on the wire, `false` when the script did not declare it. */
	required: boolean;
	description?: string;
	defaultValue?: string;
	choices?: string[];
	flag?: string;
}

/** A discovered script under the devenv home directory. */
export interface ScriptFile {
	name: string;
	relativePath: string;
	absolutePath: string;
	directory: string;
	extension: string;
	interpreter?: string;
	parameters?: ScriptParameter[];
}

/** The scripts directory under a devenv home. */
export function scriptsDir(homeDir: string): string {
	return path.join(homeDir, "scripts");
}

export const METADATA_FLAG = "--devenv-metadata";
export const METADATA_TIMEOUT_MS = 2000;
export const DEFAULT_ARGS_HISTORY_LIMIT = 50;
export const MAX_ARGS_HISTORY_LIMIT = 200;
/** Metadata discovery runs at most this many interpreters at once. */
export const METADATA_WORKERS = 10;

// --- discovery ------------------------------------------------------------

/** On Windows, an extension alone decides a script; POSIX needs the `+x` bit. */
export function windowsExtInterpreterMap(): Record<string, string> {
	return {
		".sh": "bash",
		".ps1": "pwsh",
		".py": "python",
		".ts": "bun",
		".js": "bun",
		".exe": "",
		".bat": "",
		".cmd": "",
	};
}

const RECOGNIZED_INTERPRETERS = new Set([
	"bash",
	"sh",
	"zsh",
	"python",
	"python3",
	"python3.11",
	"python3.12",
	"pwsh",
	"powershell",
	"bun",
	"node",
	"deno",
	"ruby",
	"perl",
	"lua",
	"R",
	"julia",
	"nu",
	"nu_scripts",
	"nushell",
	"rust-script",
	"dotnet",
]);

/** Whether an interpreter name is a runtime discovery recognizes. */
export function isRecognizedInterpreter(interpreter: string): boolean {
	// Go strips the trailing `.exe`/`.EXE` only, so any other casing is unknown.
	const base = interpreter.replace(/\.exe$|\.EXE$/, "");
	return RECOGNIZED_INTERPRETERS.has(base);
}

/**
 * The interpreter and leading arguments of a shebang line. `/usr/bin/env x -u`
 * reports `x` with `["-u"]`.
 */
export function readShebang(filePath: string): {
	interpreter: string;
	args: string[];
} {
	let line: string;
	try {
		line = firstLine(fs.readFileSync(filePath, "utf8"));
	} catch {
		return { interpreter: "", args: [] };
	}
	const trimmed = line.trim();
	if (!trimmed.startsWith("#!")) return { interpreter: "", args: [] };
	const rest = trimmed.slice(2).trim();
	if (rest === "") return { interpreter: "", args: [] };
	const parts = rest.split(/\s+/).filter(Boolean);
	const interpreterPath = parts[0];
	if (interpreterPath === undefined) return { interpreter: "", args: [] };
	let interpreter = path.basename(interpreterPath);
	if (interpreter === "env" && parts.length > 1) {
		interpreter = parts[1] ?? "";
		return { interpreter, args: parts.slice(2) };
	}
	return { interpreter, args: parts.slice(1) };
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index < 0 ? text : text.slice(0, index + 1);
}

/**
 * The interpreter for a discovered file: its shebang, or an extension-based
 * guess when there is none.
 */
export function readInterpreterFromShebang(
	filePath: string,
	extension: string,
): string {
	const { interpreter } = readShebang(filePath);
	if (interpreter !== "") return interpreter;
	switch (extension.toLowerCase()) {
		case ".sh":
			return "bash";
		case ".ps1":
			return "pwsh";
		case ".py":
			return "python";
		case ".ts":
		case ".js":
		case ".mjs":
		case ".cjs":
			return "bun";
		case ".rs":
			return "rust-script";
		default:
			return "";
	}
}

export interface DiscoverScriptsOptions {
	/** `process.platform` by default; `win32` switches to shebang discovery. */
	platform?: string;
}

/**
 * Recursively discovers the scripts under `directory`, sorted by relative path.
 * A missing directory is not an error: a fresh environment has no scripts yet.
 */
export function discoverScripts(
	directory: string,
	options: DiscoverScriptsOptions = {},
): ScriptFile[] {
	if (directory.trim() === "") return [];
	if (!fs.existsSync(directory)) return [];
	const platform = options.platform ?? process.platform;
	const windowsExtensions = windowsExtInterpreterMap();
	const result: ScriptFile[] = [];
	const walk = (current: string): void => {
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (platform === "win32") {
				const extension = path.extname(entry.name).toLowerCase();
				if (!(extension in windowsExtensions)) {
					const { interpreter } = readShebang(full);
					if (interpreter === "" || !isRecognizedInterpreter(interpreter)) {
						continue;
					}
				}
			} else {
				const mode = fs.statSync(full).mode;
				// At least one executable bit must be set.
				if ((mode & 0o111) === 0) continue;
			}
			const relativePath = path
				.relative(directory, full)
				.split(path.sep)
				.join("/");
			const extension = path.extname(entry.name).toLowerCase();
			result.push({
				name: entry.name,
				relativePath,
				absolutePath: full,
				directory: path.dirname(full),
				extension,
				interpreter: readInterpreterFromShebang(full, extension),
			});
		}
	};
	walk(directory);
	result.sort((a, b) =>
		a.relativePath < b.relativePath
			? -1
			: a.relativePath > b.relativePath
				? 1
				: 0,
	);
	return result;
}

// --- target paths and mutations -------------------------------------------

/**
 * Resolves a user-provided target name under `scriptsDirectory`. The result is
 * always inside the scripts directory: an absolute path, a `.` and a `..`
 * segment are rejected rather than normalized away.
 */
export function resolveScriptTargetPath(
	scriptsDirectory: string,
	targetPath: string,
	defaultExtension: string,
): { relativePath: string; absolutePath: string } {
	if (scriptsDirectory.trim() === "") {
		throw new Error("scripts directory is not configured");
	}
	const raw = targetPath.replaceAll("\\", "/").trim();
	if (raw === "") throw new Error("target name/path is required");
	if (raw.startsWith("/") || path.isAbsolute(raw)) {
		throw new Error("target name/path must be relative to scripts/");
	}
	const clean = normalizePosix(raw);
	if (clean === "." || clean === "") {
		throw new Error("target name/path is invalid");
	}
	if (clean === ".." || clean.startsWith("../")) {
		throw new Error("target name/path cannot escape scripts/");
	}
	let resolved = clean;
	if (
		path.posix.extname(clean).toLowerCase() === "" &&
		defaultExtension.trim() !== ""
	) {
		resolved = defaultExtension.startsWith(".")
			? clean + defaultExtension
			: `${clean}.${defaultExtension}`;
	}
	const absolutePath = path.join(scriptsDirectory, ...resolved.split("/"));
	const relToRoot = path
		.relative(scriptsDirectory, absolutePath)
		.split(path.sep)
		.join("/");
	if (relToRoot === ".." || relToRoot.startsWith("../")) {
		throw new Error("target name/path cannot escape scripts/");
	}
	return { relativePath: resolved, absolutePath };
}

/** `path.Clean` for a slash-separated path, kept separate to stay explicit. */
function normalizePosix(value: string): string {
	const cleaned = path.posix.normalize(value);
	return cleaned === "." && value !== "." ? "" : cleaned;
}

/** Validates an existing source file for linking. */
export function validateExistingScriptPath(sourcePath: string): {
	absolutePath: string;
	extension: string;
} {
	const raw = sourcePath.trim();
	if (raw === "") throw new Error("source script path is required");
	const absolutePath = path.resolve(raw);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolutePath);
	} catch {
		throw new Error("source script path does not exist");
	}
	if (stat.isDirectory()) {
		throw new Error("source script path must be a file");
	}
	const extension = path.extname(absolutePath).toLowerCase();
	if (extension === "") {
		throw new Error("source script must have an extension");
	}
	return { absolutePath, extension };
}

function ensureTargetDoesNotExist(targetPath: string): void {
	try {
		fs.lstatSync(targetPath);
	} catch {
		return;
	}
	throw new Error("target script already exists");
}

/** Creates a new script from a template; the target must not exist yet. */
export function createScriptFile(
	scriptsDirectory: string,
	targetPath: string,
	content: string,
): { relativePath: string; absolutePath: string } {
	const { relativePath, absolutePath } = resolveScriptTargetPath(
		scriptsDirectory,
		targetPath,
		".sh",
	);
	ensureTargetDoesNotExist(absolutePath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o755 });
	fs.writeFileSync(absolutePath, content, { mode: 0o755 });
	return { relativePath, absolutePath };
}

/** Symlinks an existing script into the scripts directory. */
export function linkScriptFile(
	scriptsDirectory: string,
	targetPath: string,
	sourcePath: string,
): { relativePath: string; absolutePath: string } {
	const source = validateExistingScriptPath(sourcePath);
	const { relativePath, absolutePath } = resolveScriptTargetPath(
		scriptsDirectory,
		targetPath,
		source.extension,
	);
	ensureTargetDoesNotExist(absolutePath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o755 });
	fs.symlinkSync(source.absolutePath, absolutePath);
	return { relativePath, absolutePath };
}

/** Removes a script target; a directory target is removed recursively. */
export function deleteScriptTarget(
	scriptsDirectory: string,
	relativePath: string,
): { relativePath: string; absolutePath: string } {
	const resolved = resolveScriptTargetPath(scriptsDirectory, relativePath, "");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved.absolutePath);
	} catch {
		throw new Error("script target does not exist");
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved.absolutePath, { recursive: true, force: true });
	} else {
		fs.unlinkSync(resolved.absolutePath);
	}
	return resolved;
}

export const DEFAULT_NEW_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
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

// --- interpreter selection ------------------------------------------------

/** The PowerShell executable available on this machine. */
export function powerShellCommand(
	lookPath: (name: string) => string | undefined = defaultLookPath,
): string {
	return lookPath("pwsh") !== undefined ? "pwsh" : "powershell";
}

function defaultLookPath(name: string): string | undefined {
	const found = Bun.which(name);
	return found === null ? undefined : found;
}

/** Maps a Unix shebang interpreter to the Windows executable to run. */
export function mapShebangToWindows(interpreter: string): string {
	const base = interpreter.replace(/\.exe$|\.EXE$/, "").toLowerCase();
	switch (base) {
		case "bash":
			return "bash";
		case "sh":
			return "sh";
		case "zsh":
			return "zsh";
		case "python":
		case "python3":
			return "python";
		case "pwsh":
		case "powershell":
			return "pwsh";
		case "bun":
			return "bun";
		case "node":
			return "node";
		case "deno":
			return "deno";
		case "ruby":
			return "ruby";
		case "perl":
			return "perl";
		default:
			return interpreter;
	}
}

/**
 * How to run a script. On POSIX the kernel's shebang handler does the work, so
 * there is no command to prefix; on Windows the interpreter has to be resolved
 * and must be present.
 */
export function resolveInterpreter(
	scriptPath: string,
	platform: string = process.platform,
): { command: string; args: string[] } {
	if (platform !== "win32") {
		// Direct execution through the shebang handler.
		return { command: "", args: [] };
	}
	const { interpreter, args } = readShebang(scriptPath);
	if (interpreter === "") {
		const mapped =
			windowsExtInterpreterMap()[path.extname(scriptPath).toLowerCase()];
		if (mapped === undefined || mapped === "") {
			throw new Error(`no interpreter found for ${scriptPath}`);
		}
		return { command: mapped, args: [scriptPath] };
	}
	return {
		command: mapShebangToWindows(interpreter),
		args: [...args, scriptPath],
	};
}

export interface ScriptExecutionPlan {
	command: string;
	args: string[];
	workingDir: string;
}

/** Resolves how to execute a discovered script with extra arguments. */
export function resolveScriptExecutionPlan(
	script: ScriptFile,
	extraArgs: readonly string[],
	options: {
		platform?: string;
		lookPath?: (name: string) => string | undefined;
	} = {},
): ScriptExecutionPlan {
	const platform = options.platform ?? process.platform;
	const workingDir =
		script.directory !== ""
			? script.directory
			: path.dirname(script.absolutePath);
	if (platform === "win32") {
		const { command, args } = resolveInterpreter(script.absolutePath, platform);
		const lookPath = options.lookPath ?? defaultLookPath;
		if (lookPath(command) === undefined) {
			throw new Error(`interpreter ${JSON.stringify(command)} not available`);
		}
		return { command, args: [...args, ...extraArgs], workingDir };
	}
	// POSIX: the script path is the command and the kernel handles the shebang.
	return { command: script.absolutePath, args: [...extraArgs], workingDir };
}

// --- metadata --------------------------------------------------------------

/**
 * Parses the `--devenv-metadata` output: a parameter array, a
 * `{parameters: [...]}` envelope, or a single parameter. Anything else yields no
 * parameters rather than failing the listing.
 */
export function parseMetadataOutput(output: string): ScriptParameter[] {
	const trimmed = output.trim();
	if (trimmed === "") return [];
	const parsed = tryParse(trimmed);
	if (parsed === undefined) return [];
	if (Array.isArray(parsed)) {
		return parsed.filter(isParameter).map(normalizeParameter);
	}
	if (isRecord(parsed)) {
		const wrapped = parsed.parameters;
		if (Array.isArray(wrapped)) {
			return wrapped.filter(isParameter).map(normalizeParameter);
		}
		if (isParameter(parsed)) return [normalizeParameter(parsed)];
	}
	return [];
}

/**
 * Drops fields the script did not declare and normalizes the ones that are
 * always on the wire, so an unknown key in a script's metadata cannot leak into
 * a response and `required` is never absent.
 */
function normalizeParameter(raw: Record<string, unknown>): ScriptParameter {
	const parameter: ScriptParameter = {
		name: typeof raw.name === "string" ? raw.name : "",
		type: typeof raw.type === "string" ? raw.type : "",
		required: raw.required === true,
	};
	if (typeof raw.description === "string" && raw.description !== "") {
		parameter.description = raw.description;
	}
	if (typeof raw.defaultValue === "string" && raw.defaultValue !== "") {
		parameter.defaultValue = raw.defaultValue;
	}
	if (Array.isArray(raw.choices) && raw.choices.length > 0) {
		parameter.choices = raw.choices.filter(
			(choice): choice is string => typeof choice === "string",
		);
	}
	if (typeof raw.flag === "string" && raw.flag !== "")
		parameter.flag = raw.flag;
	return parameter;
}

function tryParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameter(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.name === "string";
}

export interface ScriptMetadataEntry {
	parameters: ScriptParameter[];
	fileMtimeMs: number;
}

/**
 * The metadata cache. Go keys it by the sha256 of the absolute path and treats
 * an entry as fresh while the file's mtime has not advanced.
 */
export class ScriptMetadataCache {
	readonly #entries = new Map<string, ScriptMetadataEntry>();

	static key(absolutePath: string): string {
		return createHash("sha256").update(absolutePath).digest("hex");
	}

	get(absolutePath: string, mtimeMs: number): ScriptParameter[] | undefined {
		const entry = this.#entries.get(ScriptMetadataCache.key(absolutePath));
		if (!entry) return undefined;
		if (mtimeMs > entry.fileMtimeMs) return undefined;
		return entry.parameters;
	}

	set(
		absolutePath: string,
		mtimeMs: number,
		parameters: ScriptParameter[],
	): void {
		this.#entries.set(ScriptMetadataCache.key(absolutePath), {
			parameters,
			fileMtimeMs: mtimeMs,
		});
	}
}

export interface MetadataFetchOptions {
	cache?: ScriptMetadataCache;
	timeoutMs?: number;
	/** Runs the script; injected so a test never executes a real interpreter. */
	spawn?: (command: string[], timeoutMs: number) => Promise<string>;
}

/**
 * Runs a script with `--devenv-metadata` under a bounded deadline. A timeout
 * kills the whole process tree, so a script that leaves a child behind cannot
 * keep the metadata request open.
 */
export async function fetchScriptMetadata(
	scriptPath: string,
	options: MetadataFetchOptions = {},
): Promise<ScriptParameter[]> {
	const cache = options.cache;
	let mtimeMs: number | undefined;
	try {
		mtimeMs = fs.statSync(scriptPath).mtimeMs;
	} catch {
		mtimeMs = undefined;
	}
	if (cache && mtimeMs !== undefined) {
		const cached = cache.get(scriptPath, mtimeMs);
		if (cached) return cached;
	}
	const output = await (options.spawn ?? spawnMetadata)(
		[scriptPath, METADATA_FLAG],
		{
			...options,
		}.timeoutMs ?? METADATA_TIMEOUT_MS,
	);
	const parameters = parseMetadataOutput(output);
	if (cache && mtimeMs !== undefined)
		cache.set(scriptPath, mtimeMs, parameters);
	return parameters;
}

/** Runs one metadata probe and kills its process tree if it overruns. */
async function spawnMetadata(
	command: readonly string[],
	timeoutMs: number,
): Promise<string> {
	const [name, ...args] = command;
	if (name === undefined) return "";
	const proc = Bun.spawn([name, ...args], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const timer = setTimeout(() => {
		killProcessTree(proc.pid);
	}, timeoutMs);
	try {
		const output = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		return output[0];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving the input
 * order. Listing scripts probes every script for metadata, and Go bounds that at
 * ten concurrent interpreters so a large collection cannot fork-bomb the host.
 */
export async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) return;
				const item = items[index] as T;
				results[index] = await task(item, index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

// --- tree ------------------------------------------------------------------

export interface ScriptNode {
	name: string;
	relativePath: string;
	absolutePath: string;
	nodeType: "folder" | "script";
	interpreter?: string;
	parameters?: ScriptParameter[];
	children?: ScriptNode[];
}

interface MutableNode {
	name: string;
	relativePath: string;
	absolutePath: string;
	nodeType: "folder" | "script";
	interpreter?: string;
	parameters?: ScriptParameter[];
	folders: Map<string, MutableNode>;
	scripts: MutableNode[];
}

function emptyNode(init: Partial<MutableNode> & { name: string }): MutableNode {
	return {
		relativePath: "",
		absolutePath: "",
		nodeType: "folder",
		folders: new Map(),
		scripts: [],
		...init,
	};
}

/** Builds the folder/script tree the TUI renders: folders first, then scripts. */
export function buildScriptTree(scripts: readonly ScriptFile[]): ScriptNode[] {
	const root = emptyNode({ name: "" });
	for (const script of scripts) {
		const parts = script.relativePath.split("/");
		let cursor = root;
		let prefix = "";
		const scriptRoot = script.absolutePath.endsWith(script.relativePath)
			? script.absolutePath.slice(0, -script.relativePath.length)
			: "";
		parts.forEach((part, index) => {
			if (index === parts.length - 1) {
				cursor.scripts.push(
					emptyNode({
						name: script.name,
						relativePath: script.relativePath,
						absolutePath: script.absolutePath,
						nodeType: "script",
						...optionalScriptFields(script),
					}),
				);
				return;
			}
			prefix = prefix === "" ? part : `${prefix}/${part}`;
			let child = cursor.folders.get(part);
			if (!child) {
				child = emptyNode({
					name: part,
					relativePath: prefix,
					absolutePath: path.join(scriptRoot, ...prefix.split("/")),
					nodeType: "folder",
				});
				cursor.folders.set(part, child);
			}
			cursor = child;
		});
	}
	return toNodes(root);
}

/** Go's `omitempty`: an absent interpreter or parameter list is not sent. */
function optionalScriptFields(script: {
	interpreter?: string;
	parameters?: ScriptParameter[];
}): { interpreter?: string; parameters?: ScriptParameter[] } {
	return {
		...(script.interpreter ? { interpreter: script.interpreter } : {}),
		...(script.parameters && script.parameters.length > 0
			? { parameters: script.parameters }
			: {}),
	};
}

function toNodes(root: MutableNode): ScriptNode[] {
	const out: ScriptNode[] = [];
	for (const name of [...root.folders.keys()].sort()) {
		const folder = root.folders.get(name) as MutableNode;
		out.push({
			name: folder.name,
			relativePath: folder.relativePath,
			absolutePath: folder.absolutePath,
			nodeType: "folder",
			children: toNodes(folder),
		});
	}
	root.scripts.sort((a, b) =>
		a.relativePath < b.relativePath
			? -1
			: a.relativePath > b.relativePath
				? 1
				: 0,
	);
	for (const script of root.scripts) {
		out.push({
			name: script.name,
			relativePath: script.relativePath,
			absolutePath: script.absolutePath,
			nodeType: "script",
			...optionalScriptFields(script),
		});
	}
	return out;
}

// --- shell action scripts --------------------------------------------------

const SHELL_ACTION_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** tmux vs logged launch, as declared in a shell action script's header. */
export type LaunchMode = "logged" | "tmux";

export interface ShellActionScriptRequest {
	appIdent: string;
	action: string;
	profile: string;
	command: string;
	extension: ".sh" | ".ps1";
}

/**
 * Writes (or replaces) the per-app shell or PowerShell action script in the
 * configuration directory. A `run` action is profile-scoped and launches in
 * tmux; build and test are single scripts and log their output.
 */
export function writeShellActionScript(
	configDir: string,
	request: ShellActionScriptRequest,
): string {
	const { appIdent, command, extension } = request;
	if (appIdent.trim() === "") throw new Error("app ident is required");
	const action = request.action;
	if (action !== "build" && action !== "test" && action !== "run") {
		throw new Error(`unsupported shell action ${JSON.stringify(action)}`);
	}
	let profile = request.profile;
	if (action === "run") {
		if (!SHELL_ACTION_PROFILE_PATTERN.test(profile)) {
			throw new Error(
				"profile must contain only letters, numbers, underscores, and dashes",
			);
		}
	} else {
		profile = "";
	}

	const isRun = action === "run";
	const dir = path.join(configDir, "apps", isRun ? "run" : "build");
	const name = isRun
		? `${appIdent}-${profile}${extension}`
		: `${appIdent}-${action}${extension}`;
	const mode: LaunchMode = isRun ? "tmux" : "logged";
	const label = isRun
		? profile
		: action.charAt(0).toUpperCase() + action.slice(1);

	const scriptPath = path.join(dir, name);
	if (path.dirname(scriptPath) !== dir) {
		throw new Error("script path escapes config directory");
	}
	fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
	const content =
		extension === ".ps1"
			? powerShellActionScriptTemplate(label, mode, command)
			: shellActionScriptTemplate(label, mode, command);
	fs.writeFileSync(scriptPath, content, { mode: 0o755 });
	return scriptPath;
}

export function shellActionScriptTemplate(
	label: string,
	mode: LaunchMode,
	command: string,
): string {
	const trimmed = command.trim();
	const body =
		trimmed === "" ? 'echo "TODO: replace with your command"' : trimmed;
	return `#!/usr/bin/env sh\n# devenv:name=${label}\n# devenv:mode=${mode}\nset -eu\n\n${body}\n`;
}

export function powerShellActionScriptTemplate(
	label: string,
	mode: LaunchMode,
	command: string,
): string {
	const trimmed = command.trim();
	const body =
		trimmed === "" ? 'Write-Host "TODO: replace with your command"' : trimmed;
	return `# devenv:name=${label}\n# devenv:mode=${mode}\n$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\n\n${body}\n`;
}

export interface ShellScriptMetadata {
	name: string;
	mode: LaunchMode;
}

/**
 * Reads the `# devenv:name=` / `# devenv:mode=` header a shell action script
 * carries. The mode decides whether the target launches in tmux or logged, and
 * the frontend terminal launch is requested for `tmux`.
 */
export function parseShellScriptMetadata(
	scriptPath: string,
	defaultMode: LaunchMode,
): ShellScriptMetadata {
	const metadata: ShellScriptMetadata = { name: "", mode: defaultMode };
	let content: string;
	try {
		content = fs.readFileSync(scriptPath, "utf8");
	} catch {
		return metadata;
	}
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("# devenv:")) continue;
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		const key = line.slice("# devenv:".length, separator);
		const value = line.slice(separator + 1).trim();
		if (key === "name" && value !== "") metadata.name = value;
		else if (key === "mode" && (value === "tmux" || value === "logged")) {
			metadata.mode = value;
		}
	}
	return metadata;
}

export const SHELL_ACTION_LABEL_SUFFIX = {
	shell: ".sh",
	powershell: ".ps1",
} as const;
