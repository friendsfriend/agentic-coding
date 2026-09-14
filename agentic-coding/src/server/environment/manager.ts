// Bun-owned configured environment manager: definition files, runtime-state
// overlay and the canonical project catalog.
//
// Ported from `server/pkg/app/manager.go` (`port-project-catalog-and-state-to-bun`,
// tasks 2.1-2.2). Static configuration stays in the definition files; branch,
// active worktree and main-worktree branch live only in the state database, and
// a load never writes a runtime field back into a definition file.
import fs from "node:fs";
import path from "node:path";
import { liveCatalogObservation } from "./catalog-observer.ts";
import {
	APP_TYPE_APP,
	APP_TYPE_LIBRARY,
	type App,
	appConfigFileOf,
	buildProjectCatalog,
	EnvironmentConfigError,
	expandInfraConfigPaths,
	type InfraService,
	normalizeInfraService,
	type Project,
	parseAppDefinition,
	parseInfraDefinition,
	resolveActiveWorktreePath,
	resolveProjectAvailability,
	worktreeBranchToDir,
} from "./config.ts";
import type { EnvironmentStateStore } from "./state-store.ts";

export interface EnvironmentManagerOptions {
	readonly homeDir: string;
	readonly configDir: string;
	/** Runtime state source; `undefined` behaves like Go's nil store. */
	readonly store?: EnvironmentStateStore;
	readonly logger?: (message: string) => void;
}

export class EnvironmentManager {
	readonly homeDir: string;
	readonly configDir: string;
	private readonly store?: EnvironmentStateStore;
	private readonly logger: (message: string) => void;
	private apps: App[] = [];
	private infraServices: InfraService[] = [];

	constructor(options: EnvironmentManagerOptions) {
		this.homeDir = options.homeDir;
		this.configDir = options.configDir;
		this.store = options.store;
		this.logger = options.logger ?? (() => {});
	}

	// ---- Definition paths ----

	get appsDirPath(): string {
		return path.join(this.configDir, "apps", "definitions");
	}

	get librariesDirPath(): string {
		return path.join(this.configDir, "libraries", "definitions");
	}

	get infraServicesDirPath(): string {
		return path.join(this.configDir, "infrastructure", "definitions");
	}

	appFilePath(app: Pick<App, "ident" | "appType">): string {
		const dir =
			app.appType === APP_TYPE_LIBRARY
				? this.librariesDirPath
				: this.appsDirPath;
		return path.join(dir, `${app.ident}.json`);
	}

	// ---- Reads ----

	getApps(): App[] {
		return this.apps;
	}

	getInfraServices(): InfraService[] {
		return this.infraServices;
	}

	getAppByIdent(ident: string): App | undefined {
		return this.apps.find((app) => app.ident === ident);
	}

	getInfraServiceByIdent(ident: string): InfraService | undefined {
		return this.infraServices.find((service) => service.ident === ident);
	}

	getDisplayName(ident: string): string {
		return (
			this.getAppByIdent(ident)?.displayName ??
			this.getInfraServiceByIdent(ident)?.displayName ??
			ident
		);
	}

	/** Canonical catalog projection over the current in-memory snapshot. */
	getProjectCatalog(): Project[] {
		const projects = buildProjectCatalog(this.apps).map((project) =>
			resolveProjectAvailability(project, liveCatalogObservation),
		);
		return projects;
	}

	// ---- Loading ----

	/** Load configuration and overlay runtime state, refreshing branches from
	 * Git and backfilling missing runtime columns. */
	loadConfig(): void {
		this.load(false);
	}

	/**
	 * Read-only configuration load for the bounded catalog invocation: no
	 * branch refresh and no runtime backfill, so observation never mutates the
	 * environment.
	 */
	loadCatalogConfig(): void {
		this.load(true);
	}

	private load(readOnly: boolean): void {
		// Read every source before publishing, so a partial failure leaves the
		// previous snapshot intact and a failed reload keeps serving it.
		const apps = this.loadAppsFromStorage();
		const infraServices = this.loadInfraServicesFromStorage();

		this.apps = apps;
		if (infraServices.length > 0) this.infraServices = infraServices;

		this.loadRuntimeState(readOnly);
		for (const app of this.apps)
			app.localDirectoryPath = this.resolveActiveWorktreePath(app);
		if (!readOnly) this.updateBranches();
	}

	/**
	 * Merge persisted runtime state into the in-memory apps. Legacy rows whose
	 * `main_worktree_branch` is empty while an active worktree is set are
	 * backfilled from the primary worktree's current Git branch, so the
	 * primary/linked distinction keeps working. The read-only load skips that
	 * write and lets the primary-worktree fallback apply instead.
	 */
	private loadRuntimeState(readOnly: boolean): void {
		if (!this.store) return;
		for (const app of this.apps) {
			let state: ReturnType<EnvironmentStateStore["getAppState"]>;
			try {
				state = this.store.getAppState(app.ident);
			} catch (error) {
				this.logger(
					`[WARN] state: failed to load state for ${JSON.stringify(app.ident)}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}
			if (state.activeWorktree) app.activeWorktree = state.activeWorktree;
			if (state.mainWorktreeBranch)
				app.mainWorktreeBranch = state.mainWorktreeBranch;
			// The stored branch is only a fallback for a repository that is not
			// cloned yet; updateBranches() refreshes it from Git otherwise.
			if (state.branch && !app.branch) app.branch = state.branch;

			if (readOnly) continue;
			if (app.activeWorktree && !app.mainWorktreeBranch) {
				const branch = this.primaryWorktreeBranch(app.ident);
				if (!branch) continue;
				app.mainWorktreeBranch = branch;
				try {
					this.store.setMainWorktreeBranch(app.ident, branch);
					this.logger(
						`[INFO] state: backfilled MainWorktreeBranch=${JSON.stringify(branch)} for ${JSON.stringify(app.ident)}`,
					);
				} catch (error) {
					this.logger(
						`[WARN] state: failed to backfill MainWorktreeBranch for ${JSON.stringify(app.ident)}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		}
	}

	/**
	 * Refresh every app's branch from Git and persist it. A repository
	 * directory that no longer exists keeps an empty branch (so the app reads as
	 * "not cloned") instead of a stale cached value.
	 */
	private updateBranches(): void {
		for (const app of this.apps) {
			if (!app.localDirectoryPath) continue;
			const branch = currentBranchFromGit(app.localDirectoryPath);
			if (branch) {
				app.branch = branch;
				try {
					this.store?.setBranch(app.ident, branch);
				} catch (error) {
					this.logger(
						`[WARN] state: failed to persist branch for ${JSON.stringify(app.ident)}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
				continue;
			}
			if (!fs.existsSync(app.localDirectoryPath)) {
				if (!this.store) {
					app.branch = "";
					continue;
				}
				let stored = "";
				try {
					stored = this.store.getAppState(app.ident).branch;
				} catch {
					stored = "";
				}
				if (!stored) app.branch = "";
			}
		}
	}

	/** Branch checked out in the primary worktree, whatever is active now. */
	private primaryWorktreeBranch(ident: string): string {
		return currentBranchFromGit(path.join(this.homeDir, ident, ident));
	}

	/**
	 * Absolute path of the app's active worktree. A recorded linked worktree
	 * that no longer exists falls back to the primary worktree; a missing
	 * primary is returned anyway so callers see "not cloned yet".
	 */
	resolveActiveWorktreePath(app: App): string {
		const resolved = resolveActiveWorktreePath(this.homeDir, app, (target) =>
			fs.existsSync(target),
		);
		const primary = path.join(this.homeDir, app.ident, app.ident);
		if (resolved !== primary) {
			this.logger(
				`[INFO] devenv: linked worktree ${JSON.stringify(resolved)} selected for app ${JSON.stringify(app.ident)}`,
			);
			return resolved;
		}
		if (app.activeWorktree && app.activeWorktree !== app.mainWorktreeBranch) {
			const linked = path.join(
				this.homeDir,
				app.ident,
				`${app.ident}.${worktreeBranchToDir(app.activeWorktree)}`,
			);
			this.logger(
				`[INFO] devenv: active worktree directory ${JSON.stringify(linked)} no longer exists, falling back to primary worktree for app ${JSON.stringify(app.ident)}`,
			);
		}
		return resolved;
	}

	private loadAppsFromStorage(): App[] {
		return [
			...this.loadAppsFromDirectory(this.appsDirPath, APP_TYPE_APP),
			...this.loadAppsFromDirectory(this.librariesDirPath, APP_TYPE_LIBRARY),
		];
	}

	private loadAppsFromDirectory(dirPath: string, defaultType: string): App[] {
		const entries = readDefinitionEntries(
			dirPath,
			(dir) =>
				new EnvironmentConfigError(`failed to read app directory ${dir}`),
		);
		return entries.map((entry) =>
			parseAppDefinition(
				entry.name,
				fs.readFileSync(entry.path, "utf8"),
				defaultType,
			),
		);
	}

	private loadInfraServicesFromStorage(): InfraService[] {
		const dirPath = this.infraServicesDirPath;
		const entries = readDefinitionEntries(
			dirPath,
			(dir) =>
				new EnvironmentConfigError(
					`failed to read infra-services directory ${dir}`,
				),
		);
		return entries.map((entry) => {
			const parsed = expandInfraConfigPaths(
				parseInfraDefinition(entry.name, fs.readFileSync(entry.path, "utf8")),
				this.configDir,
			);
			try {
				return normalizeInfraService(parsed);
			} catch (error) {
				throw new EnvironmentConfigError(
					`invalid infra service file ${entry.name}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		});
	}

	// ---- Mutations ----

	addApp(newApp: App): void {
		if (!newApp.ident)
			throw new EnvironmentConfigError("app ident is required");
		if (!newApp.repositoryPath)
			throw new EnvironmentConfigError("app repository path is required");
		if (!newApp.displayName)
			throw new EnvironmentConfigError("app display name is required");
		if (this.apps.some((app) => app.ident === newApp.ident))
			throw new EnvironmentConfigError(
				`app with ident ${JSON.stringify(newApp.ident)} already exists`,
			);
		const conflicting = this.apps.find(
			(app) => app.repositoryPath === newApp.repositoryPath,
		);
		if (conflicting)
			throw new EnvironmentConfigError(
				`app with repository URL ${JSON.stringify(newApp.repositoryPath)} already exists (ident: ${conflicting.ident})`,
			);

		this.saveAppFile(newApp);

		if (this.store && newApp.branch) {
			const worktreeMode =
				newApp.activeWorktree !== undefined ||
				newApp.mainWorktreeBranch !== undefined ||
				newApp.gitMode === "WORKTREE";
			this.store.setAppState({
				ident: newApp.ident,
				branch: newApp.branch,
				activeWorktree: worktreeMode ? newApp.branch : "",
				mainWorktreeBranch: worktreeMode ? newApp.branch : "",
			});
		}

		this.apps = [...this.apps, newApp];
		for (const app of this.apps)
			if (!path.isAbsolute(app.localDirectoryPath))
				app.localDirectoryPath = this.resolveActiveWorktreePath(app);
	}

	removeApp(ident: string, deleteDir: boolean): void {
		if (!ident) throw new EnvironmentConfigError("app ident is required");
		const removed = this.apps.find((app) => app.ident === ident);
		if (!removed)
			throw new EnvironmentConfigError(
				`app with ident ${JSON.stringify(ident)} not found`,
			);

		try {
			fs.rmSync(this.appFilePath(removed));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new EnvironmentConfigError(
					`failed to remove app file for ${JSON.stringify(ident)}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
		}

		if (deleteDir) {
			// Branch-mode and worktree-mode apps both live under
			// $DEVENV_HOME/{ident}/, so the container directory is what goes.
			const dirPath = path.join(this.homeDir, removed.ident);
			if (dirPath && dirPath !== this.homeDir)
				fs.rmSync(dirPath, { recursive: true, force: true });
		}

		this.apps = this.apps.filter((app) => app.ident !== ident);
		for (const app of this.apps)
			if (!path.isAbsolute(app.localDirectoryPath))
				app.localDirectoryPath = this.resolveActiveWorktreePath(app);
	}

	/** Write every app/library definition and drop stale definition files. */
	saveConfig(): void {
		fs.mkdirSync(this.appsDirPath, { recursive: true, mode: 0o755 });
		fs.mkdirSync(this.librariesDirPath, { recursive: true, mode: 0o755 });
		const appEntries = fs.readdirSync(this.appsDirPath);
		const libraryEntries = fs.readdirSync(this.librariesDirPath);

		const allowedApps = new Set<string>();
		const allowedLibraries = new Set<string>();
		for (const app of this.apps) {
			this.saveAppFile(app);
			const fileName = `${app.ident}.json`;
			if (app.appType === APP_TYPE_LIBRARY) allowedLibraries.add(fileName);
			else allowedApps.add(fileName);
		}

		for (const name of appEntries) {
			if (!name.endsWith(".json") || allowedApps.has(name)) continue;
			const target = path.join(this.appsDirPath, name);
			if (!fs.statSync(target).isFile()) continue;
			fs.rmSync(target);
		}
		for (const name of libraryEntries) {
			if (!name.endsWith(".json") || allowedLibraries.has(name)) continue;
			const target = path.join(this.librariesDirPath, name);
			if (!fs.statSync(target).isFile()) continue;
			fs.rmSync(target);
		}
		this.saveInfraServices();
	}

	/**
	 * Switch the active worktree, update the in-memory checkout path and persist
	 * the runtime state. The definition file is never touched.
	 */
	updateAppActiveWorktree(ident: string, branch: string): void {
		const app = this.apps.find((candidate) => candidate.ident === ident);
		if (!app)
			throw new EnvironmentConfigError(
				`app ${JSON.stringify(ident)} not found`,
			);
		app.activeWorktree = branch;
		app.branch = branch;
		app.localDirectoryPath = this.resolveActiveWorktreePath(app);
		if (!this.store) return;
		try {
			this.store.setAppState({
				ident,
				branch,
				activeWorktree: branch,
				// Preserve whatever the primary worktree branch currently is.
				mainWorktreeBranch: app.mainWorktreeBranch ?? "",
			});
		} catch (error) {
			throw new EnvironmentConfigError(
				`failed to persist active worktree state for ${ident}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/** Record the branch actually checked out in the primary worktree after a
	 * clone. In-memory state and the state database are updated; the definition
	 * file is not. */
	setMainWorktreeBranch(ident: string, branch: string): void {
		const app = this.apps.find((candidate) => candidate.ident === ident);
		if (!app)
			throw new EnvironmentConfigError(
				`app ${JSON.stringify(ident)} not found`,
			);
		app.mainWorktreeBranch = branch;
		if (!this.store) return;
		try {
			this.store.setMainWorktreeBranch(ident, branch);
		} catch (error) {
			throw new EnvironmentConfigError(
				`failed to persist main worktree branch for ${ident}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private saveAppFile(app: App): void {
		if (!app.ident) throw new EnvironmentConfigError("app ident is required");
		const dirPath =
			app.appType === APP_TYPE_LIBRARY
				? this.librariesDirPath
				: this.appsDirPath;
		fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
		const data = `${JSON.stringify(appConfigFileOf(app), null, 2)}\n`;
		fs.writeFileSync(this.appFilePath(app), data, { mode: 0o644 });
	}

	private saveInfraServices(): void {
		fs.mkdirSync(this.infraServicesDirPath, { recursive: true, mode: 0o755 });
		const existing = fs.readdirSync(this.infraServicesDirPath);
		const allowed = new Set<string>();
		for (const service of this.infraServices) {
			const normalized = normalizeInfraService(service);
			const fileName = `${normalized.ident}.json`;
			const data = `${JSON.stringify(normalized, null, 2)}\n`;
			fs.writeFileSync(path.join(this.infraServicesDirPath, fileName), data, {
				mode: 0o644,
			});
			allowed.add(fileName);
		}
		for (const name of existing) {
			if (!name.endsWith(".json") || allowed.has(name)) continue;
			const target = path.join(this.infraServicesDirPath, name);
			if (!fs.statSync(target).isFile()) continue;
			fs.rmSync(target);
		}
	}
}

/** Definition files in a directory, sorted by name (the order Go's directory
 * read produces), or an empty list when the directory does not exist. */
function readDefinitionEntries(
	dirPath: string,
	onError: (dir: string) => Error,
): Array<{ name: string; path: string }> {
	let names: string[];
	try {
		names = fs.readdirSync(dirPath).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw onError(dirPath);
	}
	const entries: Array<{ name: string; path: string }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const entryPath = path.join(dirPath, name);
		if (!fs.statSync(entryPath).isFile()) continue;
		entries.push({ name, path: entryPath });
	}
	return entries;
}

/**
 * Current branch of a Git repository, handling both a primary worktree (`.git`
 * is a directory) and a linked worktree (`.git` is a file pointing at the
 * per-worktree git directory). Returns "" for a missing repository or a
 * detached HEAD.
 */
export function currentBranchFromGit(repoPath: string): string {
	const gitPath = path.join(repoPath, ".git");
	let stats: fs.Stats;
	try {
		stats = fs.statSync(gitPath);
	} catch {
		return "";
	}
	let headFile: string;
	if (stats.isDirectory()) {
		headFile = path.join(gitPath, "HEAD");
	} else {
		let raw: string;
		try {
			raw = fs.readFileSync(gitPath, "utf8");
		} catch {
			return "";
		}
		const gitdirLine = raw.trim();
		if (!gitdirLine.startsWith("gitdir: ")) return "";
		let actualGitDir = gitdirLine.slice("gitdir: ".length);
		if (!path.isAbsolute(actualGitDir))
			actualGitDir = path.join(repoPath, actualGitDir);
		headFile = path.join(actualGitDir, "HEAD");
	}
	let content: string;
	try {
		content = fs.readFileSync(headFile, "utf8");
	} catch {
		return "";
	}
	const head = content.trim();
	if (!head.startsWith("ref: refs/heads/")) return "";
	return head.slice("ref: refs/heads/".length);
}
