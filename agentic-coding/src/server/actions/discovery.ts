// Action-target discovery (`port-action-execution-to-bun`, task 4.2).
//
// Ported from `server/pkg/resources/{action_targets,kubernetes_discovery,
// kubernetes_config}.go`.
//
// This is the I/O boundary the definition providers call: it reads the
// configured environment (per-app compose files, shell action scripts, a
// checkout's build tooling, Helm charts) and produces the targets the compilers
// turn into immutable definitions. Nothing here decides identity — it goes
// through `actionTargetId` — and nothing here executes anything.
//
// The order of the per-runtime probes is the Go order, because the target list
// is stable-sorted by runtime and id afterwards and the tests compare it.
import fs from "node:fs";
import path from "node:path";
import { actionTargetId } from "./identity.ts";
import { powerShellCommand as powerShellExecutable } from "./scripts.ts";
import type {
	ActionRuntime,
	ActionTarget,
	AppAction,
	ContainerProvider,
	DependencyRef,
	EndpointBinding,
	EndpointExport,
	KubernetesImageConfig,
	KubernetesPortForwardConfig,
	KubernetesSecretSummary,
	KubernetesTargetMetadata,
	KubernetesWaitConfig,
	LaunchMode,
} from "./targets.ts";

export const KUBERNETES_CONFIG_FILE_NAME = "devenv.k8s.json";
export const COMPOSE_FILE_NAMES = [".yml", ".yaml"] as const;

/** The configuration a discovery run needs; no ambient reads. */
export interface DiscoveryContext {
	readonly appIdent: string;
	readonly localDir: string;
	readonly action: AppAction;
	readonly configDir: string;
	/** A second config directory whose files shadow `configDir` file by file
	 * (the `env-setup` workflow's staged configuration root). A draft therefore
	 * replaces or adds one definition without the live file being touched. */
	readonly configOverlay?: string;
	/** Platform, so the systemshell variant and interpreter names are pinned. */
	readonly platform?: string;
	/** PowerShell executable resolution. */
	readonly powerShell?: () => string;
}

/**
 * Per-file overlay resolution for a config-relative path: the overlay copy when
 * a draft exists at the same relative path, the live config file otherwise.
 * Resolution is per file, never per directory, so an unrelated live definition
 * is never shadowed by the presence of the drafts directory.
 */
export function resolveConfigFilePath(
	context: Pick<DiscoveryContext, "configDir" | "configOverlay">,
	...segments: string[]
): string {
	const base = path.join(context.configDir, ...segments);
	const overlay = context.configOverlay;
	if (!overlay) return base;
	const candidate = path.join(overlay, ...segments);
	// A draft must be a plain file or a preserved symlink. The staged root
	// recreates the live configuration's own symlinks (a symlinked compose file
	// must resolve from the staged root exactly as it does live), while the
	// approval view and the promotion still refuse a *changed* symlink as a
	// non-regular draft, so nothing the approval view does not show is ever run
	// from a draft.
	return isOverlayEntry(candidate) ? candidate : base;
}

/** Whether a candidate path is a plain file or a symlink (never a directory). */
function isOverlayEntry(candidate: string): boolean {
	try {
		const stats = fs.lstatSync(candidate);
		return stats.isFile() || stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * The files of a config-relative directory under the same per-file overlay: a
 * name present in both directories resolves to the overlay file. Names are
 * sorted, so the target list stays deterministic.
 */
export function configDirEntries(
	context: Pick<DiscoveryContext, "configDir" | "configOverlay">,
	...segments: string[]
): Array<{ name: string; path: string }> {
	const names = new Set<string>();
	for (const dir of [context.configDir, context.configOverlay]) {
		if (!dir) continue;
		const target = path.join(dir, ...segments);
		if (!dirExists(target)) continue;
		for (const name of fs.readdirSync(target)) {
			const candidate = path.join(target, name);
			// The live configuration keeps its current behaviour (a real file); the
			// overlay contributes a plain file or a preserved symlink.
			if (
				dir === context.configDir
					? fileExists(candidate)
					: isOverlayEntry(candidate)
			)
				names.add(name);
		}
	}
	return [...names].sort().map((name) => ({
		name,
		path: resolveConfigFilePath(context, ...segments, name),
	}));
}

/**
 * Profile variants an app has configured: `{ident}-{profile}-compose.yml` files
 * in the compose directory. Ported from `resources.Manager.DiscoverProfiles`.
 */
export function discoverProfiles(
	configDir: string,
	appIdent: string,
): string[] {
	const composeDir = path.join(configDir, "apps", "compose");
	let entries: string[];
	try {
		entries = fs.readdirSync(composeDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`reading compose directory: ${String(error)}`);
	}
	const prefix = `${appIdent}-`;
	const profiles: string[] = [];
	for (const name of entries) {
		for (const suffix of ["-compose.yml", "-compose.yaml"]) {
			if (
				name.length >= prefix.length + suffix.length + 1 &&
				name.startsWith(prefix) &&
				name.endsWith(suffix)
			) {
				profiles.push(name.slice(prefix.length, name.length - suffix.length));
			}
		}
	}
	return profiles;
}

/**
 * The shell-action Dockerfile for an action, under `apps/build`. Ported from
 * `resources.Manager.ResolveDockerfileForAction`; a missing file is the
 * `hasDockerfile: false` the profile picker renders.
 */
export function resolveDockerfileForAction(
	configDir: string,
	appIdent: string,
	action: AppAction,
): string | undefined {
	const file = path.join(
		configDir,
		"apps",
		"build",
		`${appIdent}-${action}.Dockerfile`,
	);
	return fs.existsSync(file) ? file : undefined;
}

function platformOf(context: DiscoveryContext): string {
	return context.platform ?? process.platform;
}

function powerShell(context: DiscoveryContext): string {
	return (context.powerShell ?? powerShellExecutable)();
}

/** Every target for one app and action, sorted by runtime then id. */
export function discoverActionTargets(
	context: DiscoveryContext,
): ActionTarget[] {
	let targets: ActionTarget[] = [];
	switch (context.action) {
		case "build":
		case "test": {
			const dockerTarget = discoverDockerBuildTestTarget(context);
			if (dockerTarget) targets.push(dockerTarget);
			targets = targets.concat(discoverScriptBuildTestTargets(context));
			targets = targets.concat(discoverRootBuildToolTargets(context));
			targets = targets.concat(discoverLanguageBuildToolTargets(context));
			break;
		}
		case "run": {
			targets = targets.concat(discoverDockerRunTargets(context));
			targets = targets.concat(discoverScriptRunTargets(context));
			targets = targets.concat(discoverKubernetesRunTargets(context));
			targets = targets.concat(discoverRootBuildToolTargets(context));
			targets = targets.concat(discoverLanguageBuildToolTargets(context));
			break;
		}
		default:
			throw new Error(
				`unsupported app action ${JSON.stringify(context.action)}`,
			);
	}
	return targets.sort((a, b) => {
		if (a.runtime !== b.runtime) return a.runtime < b.runtime ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function dirExists(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

// --- configured targets ---------------------------------------------------

/** A Dockerfile the shell-action writer placed in the config directory. */
function discoverDockerBuildTestTarget(
	context: DiscoveryContext,
): ActionTarget | undefined {
	const sourcePath = resolveConfigFilePath(
		context,
		"apps",
		"build",
		`${context.appIdent}-${context.action}.Dockerfile`,
	);
	if (!fileExists(sourcePath)) return undefined;
	return {
		id: actionTargetId(context.appIdent, context.action, "docker", ""),
		action: context.action,
		runtime: "docker",
		label: "Docker",
		sourcePath,
	};
}

/** Shell and PowerShell build/test scripts in the config directory. */
function discoverScriptBuildTestTargets(
	context: DiscoveryContext,
): ActionTarget[] {
	const targets: ActionTarget[] = [];
	for (const candidate of [
		{
			ext: ".sh",
			runtime: "shell" as ActionRuntime,
			label: "Shell",
			command: "sh",
			args: (scriptPath: string) => [scriptPath],
		},
		{
			ext: ".ps1",
			runtime: "powershell" as ActionRuntime,
			label: "PowerShell",
			command: powerShell(context),
			args: (scriptPath: string) => [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
			],
		},
	]) {
		const sourcePath = resolveConfigFilePath(
			context,
			"apps",
			"build",
			`${context.appIdent}-${context.action}${candidate.ext}`,
		);
		if (!fileExists(sourcePath)) continue;
		const metadata = parseShellScriptMetadata(sourcePath, "logged");
		targets.push({
			id: actionTargetId(
				context.appIdent,
				context.action,
				candidate.runtime,
				"",
			),
			action: context.action,
			runtime: candidate.runtime,
			label: metadata.name !== "" ? metadata.name : candidate.label,
			launchMode: metadata.mode,
			sourcePath,
			command: candidate.command,
			args: candidate.args(sourcePath),
			...(metadata.requires.length > 0 ? { requires: metadata.requires } : {}),
		});
	}
	return targets;
}

/** A compose file per profile, configured in `config/apps/compose`. */
function discoverDockerRunTargets(context: DiscoveryContext): ActionTarget[] {
	const targets: ActionTarget[] = [];
	const prefix = `${context.appIdent}-`;
	for (const { name, path: sourcePath } of configDirEntries(
		context,
		"apps",
		"compose",
	)) {
		const isDefault = COMPOSE_FILE_NAMES.some(
			(extension) => name === `${context.appIdent}-compose${extension}`,
		);
		if (isDefault) {
			targets.push({
				id: actionTargetId(context.appIdent, "run", "docker", "default"),
				action: "run",
				runtime: "docker",
				label: "default",
				sourcePath,
				requires: parseComposeRequires(sourcePath),
			});
			continue;
		}
		for (const extension of COMPOSE_FILE_NAMES) {
			const suffix = `-compose${extension}`;
			if (
				!name.startsWith(prefix) ||
				!name.endsWith(suffix) ||
				name.length <= prefix.length + suffix.length
			) {
				continue;
			}
			const profile = name.slice(prefix.length, name.length - suffix.length);
			targets.push({
				id: actionTargetId(context.appIdent, "run", "docker", profile),
				action: "run",
				runtime: "docker",
				label: profile,
				profile,
				sourcePath,
				requires: parseComposeRequires(sourcePath),
			});
		}
	}
	return targets;
}

/** Shell, PowerShell and system-shell run scripts in `config/apps/run`. */
function discoverScriptRunTargets(context: DiscoveryContext): ActionTarget[] {
	const entries = configDirEntries(context, "apps", "run");
	const targets: ActionTarget[] = [];
	const prefix = `${context.appIdent}-`;
	for (const { name, path: sourcePath } of entries) {
		for (const candidate of [
			{
				ext: ".sh",
				runtime: "shell" as ActionRuntime,
				command: "sh",
				args: (scriptPath: string) => [scriptPath],
			},
			{
				ext: ".ps1",
				runtime: "powershell" as ActionRuntime,
				command: powerShell(context),
				args: (scriptPath: string) => [
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					scriptPath,
				],
			},
		]) {
			if (
				!name.startsWith(prefix) ||
				!name.endsWith(candidate.ext) ||
				name.length <= prefix.length + candidate.ext.length
			) {
				continue;
			}
			const profile = name.slice(
				prefix.length,
				name.length - candidate.ext.length,
			);
			const metadata = parseShellScriptMetadata(sourcePath, "tmux");
			targets.push({
				id: actionTargetId(context.appIdent, "run", candidate.runtime, profile),
				action: "run",
				runtime: candidate.runtime,
				label: metadata.name !== "" ? metadata.name : profile,
				profile,
				launchMode: metadata.mode,
				sourcePath,
				command: candidate.command,
				args: candidate.args(sourcePath),
				...(metadata.requires.length > 0
					? { requires: metadata.requires }
					: {}),
			});
		}
	}
	targets.push(...discoverSystemShellRunTargets(context, entries, prefix));
	return targets;
}

/**
 * The same run scripts, offered again through the system shell. On Windows that
 * is the system PowerShell, which is why the extension and interpreter follow the
 * platform rather than the script's own shebang.
 */
function discoverSystemShellRunTargets(
	context: DiscoveryContext,
	entries: readonly { name: string; path: string }[],
	prefix: string,
): ActionTarget[] {
	const windows = platformOf(context) === "win32";
	const extension = windows ? ".ps1" : ".sh";
	const command = windows ? powerShell(context) : "sh";
	const labelPrefix = windows ? "System PowerShell" : "System Shell";
	const targets: ActionTarget[] = [];
	for (const { name, path: sourcePath } of entries) {
		if (
			!name.startsWith(prefix) ||
			!name.endsWith(extension) ||
			name.length <= prefix.length + extension.length
		) {
			continue;
		}
		const profile = name.slice(prefix.length, name.length - extension.length);
		const metadata = parseShellScriptMetadata(sourcePath, "tmux");
		targets.push({
			id: actionTargetId(context.appIdent, "run", "systemshell", profile),
			action: "run",
			runtime: "systemshell",
			label: metadata.name !== "" ? metadata.name : `${labelPrefix} ${profile}`,
			profile,
			launchMode: metadata.mode,
			sourcePath,
			command,
			args: windows
				? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sourcePath]
				: [sourcePath],
			...(metadata.requires.length > 0 ? { requires: metadata.requires } : {}),
		});
	}
	return targets;
}

// --- checkout targets -----------------------------------------------------

/** Build tooling at the checkout root: make, just, task. */
function discoverRootBuildToolTargets(
	context: DiscoveryContext,
): ActionTarget[] {
	if (context.localDir === "") return [];
	const targets: ActionTarget[] = [];
	for (const candidate of [
		{
			files: ["Makefile", "makefile"],
			label: `make ${context.action} (default for Makefile)`,
			command: "make",
			args: [context.action],
			hasTarget: (line: string) => line.startsWith(`${context.action}:`),
			profileHint: "make",
		},
		{
			files: ["justfile", "Justfile"],
			label: `just ${context.action} (default for justfile)`,
			command: "just",
			args: [context.action],
			hasTarget: (line: string) => line.startsWith(`${context.action}:`),
			profileHint: "just",
		},
		{
			files: ["Taskfile.yml", "Taskfile.yaml", "Taskfile"],
			label: `task ${context.action} (default for Taskfile)`,
			command: "task",
			args: [context.action],
			hasTarget: (line: string) => line.startsWith(`  ${context.action}:`),
			profileHint: "task",
		},
	]) {
		for (const name of candidate.files) {
			const sourcePath = path.join(context.localDir, name);
			if (!fileExists(sourcePath)) continue;
			if (!fileHasLine(sourcePath, candidate.hasTarget)) continue;
			let profile = path.basename(name, path.extname(name)).toLowerCase();
			if (profile.startsWith("makefile")) profile = candidate.profileHint;
			else if (profile.startsWith("justfile")) profile = candidate.profileHint;
			else if (profile.startsWith("taskfile")) profile = candidate.profileHint;
			targets.push({
				id: actionTargetId(context.appIdent, context.action, "shell", profile),
				action: context.action,
				runtime: "shell",
				label: candidate.label,
				profile,
				launchMode: context.action === "run" ? "tmux" : "logged",
				sourcePath,
				command: candidate.command,
				args: candidate.args,
			});
			break;
		}
	}
	return targets;
}

/** Language tooling at the checkout root: package.json, go, cargo and friends. */
function discoverLanguageBuildToolTargets(
	context: DiscoveryContext,
): ActionTarget[] {
	if (context.localDir === "") return [];
	const targets: ActionTarget[] = [];
	const add = (
		profile: string,
		label: string,
		sourcePath: string,
		command: string,
		...args: string[]
	): void => {
		targets.push({
			id: actionTargetId(context.appIdent, context.action, "shell", profile),
			action: context.action,
			runtime: "shell",
			label,
			profile,
			launchMode: context.action === "run" ? "tmux" : "logged",
			sourcePath,
			command,
			args,
		});
	};

	const packageJson = path.join(context.localDir, "package.json");
	const scripts = readPackageScripts(packageJson);
	if (scripts) {
		const script =
			context.action === "run"
				? "dev" in scripts
					? "dev"
					: "start"
				: context.action;
		if (script in scripts) {
			const [manager, args] = packageManagerCommand(context.localDir, script);
			add(
				`package-${manager}`,
				`${manager} ${script} (default for package.json)`,
				packageJson,
				manager,
				...args,
			);
		} else if (context.action === "test") {
			const [manager] = packageManagerCommand(context.localDir, script);
			if (manager === "bun") {
				add(
					"package-bun",
					"bun test (default for package.json)",
					packageJson,
					"bun",
					"test",
				);
			}
		}
	}

	const goMod = path.join(context.localDir, "go.mod");
	if (fileExists(goMod)) {
		if (context.action === "build") {
			add("go", "go build (default for go.mod)", goMod, "go", "build", "./...");
		} else if (context.action === "test") {
			add("go", "go test (default for go.mod)", goMod, "go", "test", "./...");
		} else {
			add("go", "go run . (default for go.mod)", goMod, "go", "run", ".");
		}
	}

	const cargoToml = path.join(context.localDir, "Cargo.toml");
	if (fileExists(cargoToml)) {
		add(
			"cargo",
			`cargo ${context.action} (default for Cargo.toml)`,
			cargoToml,
			"cargo",
			context.action,
		);
	}

	const pomXml = path.join(context.localDir, "pom.xml");
	if (fileExists(pomXml)) {
		if (context.action === "build") {
			add(
				"maven",
				"mvn package (default for pom.xml)",
				pomXml,
				"mvn",
				"package",
			);
		} else if (context.action === "test") {
			add("maven", "mvn test (default for pom.xml)", pomXml, "mvn", "test");
		}
	}

	const gradle = firstExistingFile(context.localDir, [
		"gradlew",
		"build.gradle",
		"build.gradle.kts",
	]);
	if (gradle) {
		const command =
			path.basename(gradle) === "gradlew" ? "./gradlew" : "gradle";
		add(
			"gradle",
			`${command} ${context.action} (default for Gradle)`,
			gradle,
			command,
			context.action,
		);
	}

	const pyproject = path.join(context.localDir, "pyproject.toml");
	if (fileExists(pyproject) && context.action !== "run") {
		const hasUv = fileExists(path.join(context.localDir, "uv.lock"));
		if (context.action === "build") {
			if (hasUv) {
				add(
					"uv",
					"uv build (default for pyproject.toml)",
					pyproject,
					"uv",
					"build",
				);
			} else {
				add(
					"poetry",
					"poetry build (default for pyproject.toml)",
					pyproject,
					"poetry",
					"build",
				);
			}
		} else if (hasUv) {
			add(
				"uv",
				"uv run pytest (default for pyproject.toml)",
				pyproject,
				"uv",
				"run",
				"pytest",
			);
		} else {
			add(
				"poetry",
				"poetry run pytest (default for pyproject.toml)",
				pyproject,
				"poetry",
				"run",
				"pytest",
			);
		}
	}
	return targets;
}

function readPackageScripts(
	packageJson: string,
): Record<string, string> | undefined {
	if (!fileExists(packageJson)) return undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJson, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const scripts = (parsed as { scripts?: unknown }).scripts;
		if (typeof scripts !== "object" || scripts === null) return {};
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(scripts)) {
			if (typeof value === "string") out[key] = value;
		}
		return out;
	} catch {
		return undefined;
	}
}

/**
 * Which package manager to invoke: the `packageManager` field first, then the
 * lockfile, then npm. Yarn has no `run` subcommand.
 */
export function packageManagerCommand(
	localDir: string,
	script: string,
): [string, string[]] {
	const declared = readDeclaredPackageManager(
		path.join(localDir, "package.json"),
	);
	if (declared !== undefined) {
		if (declared.startsWith("bun@") || declared === "bun") {
			return ["bun", ["run", script]];
		}
		if (declared.startsWith("pnpm@") || declared === "pnpm") {
			return ["pnpm", ["run", script]];
		}
		if (declared.startsWith("yarn@") || declared === "yarn") {
			return ["yarn", [script]];
		}
		if (declared.startsWith("npm@") || declared === "npm") {
			return ["npm", ["run", script]];
		}
	}
	if (fileExists(path.join(localDir, "bun.lock")))
		return ["bun", ["run", script]];
	if (fileExists(path.join(localDir, "bun.lockb")))
		return ["bun", ["run", script]];
	if (fileExists(path.join(localDir, "pnpm-lock.yaml"))) {
		return ["pnpm", ["run", script]];
	}
	if (fileExists(path.join(localDir, "yarn.lock"))) return ["yarn", [script]];
	return ["npm", ["run", script]];
}

function readDeclaredPackageManager(packageJson: string): string | undefined {
	if (!fileExists(packageJson)) return undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJson, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const value = (parsed as { packageManager?: unknown }).packageManager;
		return typeof value === "string" && value !== "" ? value : undefined;
	} catch {
		return undefined;
	}
}

function firstExistingFile(
	dir: string,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const candidate = path.join(dir, name);
		if (fileExists(candidate)) return candidate;
	}
	return undefined;
}

function fileHasLine(
	filePath: string,
	matches: (line: string) => boolean,
): boolean {
	try {
		return fs
			.readFileSync(filePath, "utf8")
			.split("\n")
			.some((line) => matches(line));
	} catch {
		return false;
	}
}

// --- kubernetes targets ---------------------------------------------------

interface KubernetesRunTargetConfig {
	profile?: string;
	provider?: ContainerProvider;
	cluster?: string;
	context?: string;
	name?: string;
	chart: { path?: string; values?: string[] };
	release?: string;
	namespace?: string;
	/** The Helm value a requested replica count is written to. Absent leaves the
	 * deployment plan's own default (`replicaCount`). */
	replicasValuePath?: string;
	values?: string[];
	image?: KubernetesImageConfig;
	secrets?: { name: string; keys: string[] }[];
	wait?: KubernetesWaitConfig;
	ports?: KubernetesPortForwardConfig[];
	requires?: DependencyRef[];
	exports?: EndpointExport[];
	bindings?: EndpointBinding[];
}

function discoverKubernetesRunTargets(
	context: DiscoveryContext,
): ActionTarget[] {
	const targets: ActionTarget[] = [];
	const seen = new Set<string>();
	const add = (target: ActionTarget): void => {
		if (seen.has(target.id)) return;
		seen.add(target.id);
		targets.push(target);
	};

	for (const chart of discoverHelmCharts(context.localDir)) {
		let profile = kubernetesProfileForChart(chart);
		if (path.resolve(chart) === path.resolve(context.localDir))
			profile = "local";
		add(
			kubernetesActionTarget(
				context,
				{
					profile,
					chart: { path: chart },
					release: defaultKubernetesRelease(context.appIdent, profile),
					namespace: "default",
				},
				chart,
			),
		);
	}

	const configAppDir = path.join(
		context.configDir,
		"apps",
		"k8s",
		context.appIdent,
	);
	const configPath = resolveConfigFilePath(
		context,
		"apps",
		"k8s",
		context.appIdent,
		KUBERNETES_CONFIG_FILE_NAME,
	);
	let hasExplicitConfig = false;
	if (fileExists(configPath)) {
		hasExplicitConfig = true;
		const config = loadKubernetesConfig(
			configPath,
			context.localDir,
			context.configDir,
		);
		config.targets?.forEach((target, index) => {
			const resolved: KubernetesRunTargetConfig = { ...target };
			if (!resolved.profile) resolved.profile = `local-${index + 1}`;
			if (!resolved.release) {
				resolved.release = defaultKubernetesRelease(
					context.appIdent,
					resolved.profile,
				);
			}
			if (!resolved.namespace) resolved.namespace = "default";
			add(kubernetesActionTarget(context, resolved, configPath));
		});
	}

	// Config-directory Kubernetes run configs: one file per app and profile,
	// `<app>-<profile>.k8s.json` under `apps/kubernetes`. The file's profile is
	// the target's profile, and `$APP` in its paths resolves to the checkout, so
	// a k8s run config never has to live in the app repository. Drafts resolve
	// through the same per-file overlay as every other config file.
	const kubernetesPrefix = `${context.appIdent}-`;
	const kubernetesSuffix = ".k8s.json";
	for (const { name, path: kubernetesPath } of configDirEntries(
		context,
		"apps",
		"kubernetes",
	)) {
		if (
			!name.startsWith(kubernetesPrefix) ||
			!name.endsWith(kubernetesSuffix) ||
			name.length <= kubernetesPrefix.length + kubernetesSuffix.length
		)
			continue;
		const fileProfile = name.slice(
			kubernetesPrefix.length,
			name.length - kubernetesSuffix.length,
		);
		for (const resolved of loadKubernetesTargetFile(
			kubernetesPath,
			context.localDir,
			context.configDir,
			fileProfile,
		)) {
			if (!resolved.release)
				resolved.release = defaultKubernetesRelease(
					context.appIdent,
					resolved.profile ?? fileProfile,
				);
			if (!resolved.namespace) resolved.namespace = "default";
			add(kubernetesActionTarget(context, resolved, kubernetesPath));
		}
	}

	if (!hasExplicitConfig) {
		const chart = firstExistingChartDir([
			configAppDir,
			path.join(configAppDir, "chart"),
			path.join(configAppDir, "helm"),
		]);
		if (chart !== undefined) {
			const profile = kubernetesProfileForChart(chart);
			add(
				kubernetesActionTarget(
					context,
					{
						profile,
						chart: { path: chart },
						release: defaultKubernetesRelease(context.appIdent, profile),
						namespace: "default",
					},
					chart,
				),
			);
		}
	}

	return targets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Helm chart directories under a checkout: root, chart, helm, deploy/helm, charts/*. */
export function discoverHelmCharts(root: string): string[] {
	if (root === "") return [];
	const candidates = [
		path.join(root, "."),
		path.join(root, "chart"),
		path.join(root, "helm"),
		path.join(root, "deploy", "helm"),
	];
	const chartsDir = path.join(root, "charts");
	if (dirExists(chartsDir)) {
		for (const entry of fs.readdirSync(chartsDir, { withFileTypes: true })) {
			if (entry.isDirectory())
				candidates.push(path.join(chartsDir, entry.name));
		}
	}
	return existingChartDirs(candidates);
}

function existingChartDirs(candidates: readonly string[]): string[] {
	const charts: string[] = [];
	const seen = new Set<string>();
	for (const dir of candidates) {
		if (!fileExists(path.join(dir, "Chart.yaml"))) continue;
		const clean = path.resolve(dir);
		if (seen.has(clean)) continue;
		seen.add(clean);
		charts.push(clean);
	}
	return charts.sort();
}

function firstExistingChartDir(
	candidates: readonly string[],
): string | undefined {
	return existingChartDirs(candidates)[0];
}

/**
 * The profile a chart directory implies: its basename, `-chart` trimmed, with
 * `chart` and `helm` meaning the local profile.
 */
export function kubernetesProfileForChart(chartPath: string): string {
	const base = path.basename(chartPath);
	if (base === "." || base === path.sep || base === "") return "local";
	const profile = base.toLowerCase().replace(/-chart$/, "");
	if (profile === "chart" || profile === "helm") return "local";
	return profile;
}

export function defaultKubernetesRelease(
	appIdent: string,
	profile: string,
): string {
	if (profile === "" || profile === "local") return appIdent;
	return `${appIdent}-${profile}`;
}

/**
 * One config-directory Kubernetes run config (`<app>-<profile>.k8s.json`):
 * either a `{ targets: [...] }` envelope or a single run-target object. The
 * file name's profile is the default for entries that declare none.
 */
function loadKubernetesTargetFile(
	configPath: string,
	appDir: string,
	configDir: string,
	fileProfile: string,
): KubernetesRunTargetConfig[] {
	const { targets } = loadKubernetesConfigWithDefault(
		configPath,
		appDir,
		configDir,
		fileProfile,
	);
	return targets;
}

function loadKubernetesConfig(
	configPath: string,
	appDir: string,
	configDir: string,
): { targets?: KubernetesRunTargetConfig[] } {
	return loadKubernetesConfigWithDefault(configPath, appDir, configDir, "");
}

function loadKubernetesConfigWithDefault(
	configPath: string,
	appDir: string,
	configDir: string,
	defaultProfile: string,
): { targets: KubernetesRunTargetConfig[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(
			`${configPath}: invalid Kubernetes run config: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) return { targets: [] };
	const baseDir = path.dirname(configPath);
	const envelope = (parsed as { targets?: unknown }).targets;
	// A file with no `targets` array is one run target: the config-directory
	// convention is one file per app and profile.
	const raw = Array.isArray(envelope)
		? envelope
		: envelope === undefined && "chart" in parsed
			? [parsed]
			: [];
	const targets = raw
		.filter(
			(entry): entry is Record<string, unknown> =>
				typeof entry === "object" && entry !== null,
		)
		.map((entry) => {
			const target = entry as unknown as KubernetesRunTargetConfig;
			if (!target.profile && defaultProfile !== "")
				target.profile = defaultProfile;
			const identity = applyKubernetesIdentity(
				target.provider,
				target.cluster,
				target.context,
				target.profile ?? "",
			);
			target.provider = identity.provider;
			target.cluster = identity.cluster;
			target.context = identity.context;
			target.chart = {
				...target.chart,
				path: expandKubernetesPath(
					target.chart?.path ?? "",
					appDir,
					configDir,
					baseDir,
				),
				...(target.chart?.values
					? {
							values: target.chart.values.map((value) =>
								expandKubernetesPath(value, appDir, configDir, baseDir),
							),
						}
					: {}),
			};
			if (target.values) {
				target.values = target.values.map((value) =>
					expandKubernetesPath(value, appDir, configDir, baseDir),
				);
			}
			return target;
		});
	return { targets };
}

/**
 * Defaults a Kubernetes identity: docker, and a profile-scoped cluster with the
 * matching `kind-` context.
 */
export function applyKubernetesIdentity(
	provider: ContainerProvider | undefined,
	cluster: string | undefined,
	context: string | undefined,
	profile: string,
): { provider: ContainerProvider; cluster: string; context: string } {
	const resolvedProvider: ContainerProvider = provider ? provider : "docker";
	let resolvedCluster = cluster ?? "";
	if (resolvedCluster === "") {
		resolvedCluster = "devenv";
		if (profile !== "" && profile !== "local") resolvedCluster += `-${profile}`;
	}
	const resolvedContext =
		context && context !== "" ? context : `kind-${resolvedCluster}`;
	return {
		provider: resolvedProvider,
		cluster: resolvedCluster,
		context: resolvedContext,
	};
}

/** `$APP` / `$CONFIG` expansion, then absolute or config-file-relative. */
export function expandKubernetesPath(
	value: string,
	appDir: string,
	configDir: string,
	baseDir: string,
): string {
	if (value === "") return "";
	const expanded = value
		.replaceAll("$APP", appDir)
		.replaceAll("$CONFIG", configDir);
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.normalize(path.join(baseDir, expanded));
}

function kubernetesActionTarget(
	context: DiscoveryContext,
	config: KubernetesRunTargetConfig,
	sourcePath: string,
): ActionTarget {
	const profile =
		config.profile && config.profile !== "" ? config.profile : "local";
	const values = [...(config.chart.values ?? []), ...(config.values ?? [])];
	const secrets: KubernetesSecretSummary[] = (config.secrets ?? []).map(
		(secret) => ({ name: secret.name, keys: [...secret.keys] }),
	);
	const label =
		config.name && config.name !== "" ? config.name : `Kubernetes ${profile}`;
	// Chart discovery defaults the identity without profile scoping: only an
	// explicit `devenv.k8s.json` applies the profile-scoped cluster name.
	const provider: ContainerProvider = config.provider
		? config.provider
		: "docker";
	const clusterName =
		config.cluster && config.cluster !== "" ? config.cluster : "devenv";
	const contextName =
		config.context && config.context !== ""
			? config.context
			: `kind-${clusterName}`;
	const replicasValuePath = (config.replicasValuePath ?? "").trim();
	const kubernetes: KubernetesTargetMetadata = {
		provider,
		clusterName,
		contextName,
		chartPath: config.chart.path ?? "",
		release: config.release ?? "",
		namespace: config.namespace ?? "",
		// A configured path is carried as it is; an unconfigured one stays absent
		// so the deployment plan's default is the single place it is decided.
		...(replicasValuePath !== "" ? { replicasValuePath } : {}),
		...(values.length > 0 ? { valuesFiles: values } : {}),
		...(config.image ? { image: config.image } : {}),
		...(secrets.length > 0 ? { secrets } : {}),
		...(config.ports && config.ports.length > 0 ? { ports: config.ports } : {}),
		// Go's `omitempty` cannot drop a struct field, so the wait block is
		// always on the wire, empty when nothing was configured.
		wait: config.wait ?? {},
		...(config.exports && config.exports.length > 0
			? { exports: config.exports }
			: {}),
		...(config.bindings && config.bindings.length > 0
			? { bindings: config.bindings }
			: {}),
		sourcePath,
	};
	return {
		id: actionTargetId(context.appIdent, "run", "kubernetes", profile),
		provider,
		action: "run",
		runtime: "kubernetes",
		label,
		profile,
		sourcePath,
		...(config.requires ? { requires: config.requires } : {}),
		...(config.exports ? { exports: config.exports } : {}),
		...(config.bindings ? { bindings: config.bindings } : {}),
		kubernetes,
	};
}

// --- script metadata ------------------------------------------------------

export interface ShellScriptMetadata {
	name: string;
	mode: LaunchMode;
	requires: DependencyRef[];
}

/**
 * Reads the `# devenv:name=` / `# devenv:mode=` / `# devenv:requires=` header of
 * a shell action script. Only the leading comment block counts: the first line
 * that is not a comment ends the header.
 */
export function parseShellScriptMetadata(
	scriptPath: string,
	defaultMode: LaunchMode,
): ShellScriptMetadata {
	const metadata: ShellScriptMetadata = {
		name: "",
		mode: defaultMode,
		requires: [],
	};
	let content: string;
	try {
		content = fs.readFileSync(scriptPath, "utf8");
	} catch {
		return metadata;
	}
	let lines = 0;
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		lines++;
		if (lines > 20) break;
		if (line === "" || line.startsWith("#!")) continue;
		if (!line.startsWith("#")) break;
		const comment = line.replace(/^#\s*/, "").trim();
		if (comment.startsWith("devenv:name=")) {
			metadata.name = comment.slice("devenv:name=".length).trim();
		}
		if (comment.startsWith("devenv:mode=")) {
			metadata.mode = comment.slice("devenv:mode=".length).trim() as LaunchMode;
		}
		if (comment.startsWith("devenv:requires=")) {
			metadata.requires = parseDependencyRefs(
				comment.slice("devenv:requires=".length).trim(),
				scriptPath,
			);
		}
	}
	return metadata;
}

/** Parses and validates a `devenv:requires` JSON array. */
export function parseDependencyRefs(
	raw: string,
	source: string,
): DependencyRef[] {
	if (raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`parse ${source} devenv:requires: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`parse ${source} devenv:requires: expected an array`);
	}
	return parsed.map((entry, index) => {
		const ref = entry as DependencyRef;
		if (!ref.app && !ref.infra) {
			throw new Error(`dependency ${index} requires app or infra`);
		}
		if (ref.app && ref.infra) {
			throw new Error(`dependency ${index} cannot contain both app and infra`);
		}
		if (ref.app) {
			if (!ref.runtime) {
				throw new Error(
					`dependency ${index} app ${JSON.stringify(ref.app)} requires runtime`,
				);
			}
			if (!ref.profile) {
				throw new Error(
					`dependency ${index} app ${JSON.stringify(ref.app)} requires profile`,
				);
			}
		}
		return ref;
	});
}

/**
 * Reads the inline `x-devenv: requires:` list from a compose file. It must be
 * inline JSON: a nested YAML block is rejected rather than half-parsed.
 */
export function parseComposeRequires(composePath: string): DependencyRef[] {
	let content: string;
	try {
		content = fs.readFileSync(composePath, "utf8");
	} catch {
		return [];
	}
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trim();
		if (!trimmed.startsWith("x-devenv:")) continue;
		for (let j = i + 1; j < lines.length; j++) {
			const raw = lines[j] ?? "";
			const child = raw.trim();
			if (child === "" || child.startsWith("#")) continue;
			if (!raw.startsWith(" ") && !raw.startsWith("\t")) break;
			if (child.startsWith("requires:")) {
				const inline = child.slice("requires:".length).trim();
				if (inline === "") {
					throw new Error(
						`${composePath} x-devenv.requires must be inline JSON array`,
					);
				}
				return parseDependencyRefs(inline, composePath);
			}
		}
	}
	return [];
}
