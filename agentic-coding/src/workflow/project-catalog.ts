// The single asynchronous configured-project catalog client. Workflow
// creation, workflow history, telemetry watch roots and CLI project listing
// all consume this boundary; no consumer re-scans directories or re-parses
// configuration on its own.
//
// A catalog request has three observable states the callers must keep apart:
//   • a valid catalog (possibly empty — a valid configuration state),
//   • a non-retryable configuration error (for example duplicate idents),
//   • a retryable transport/server failure.
import fs from "node:fs";
import path from "node:path";
import {
	createCustomFetch,
	ProjectCatalogError,
	getProjectCatalog as requestProjectCatalog,
} from "@devenv/core";
import type { CatalogProject, ProjectCatalog } from "@devenv/types";

export type { CatalogProject, ProjectCatalog };
export { ProjectCatalogError };

const DEFAULT_BASE_URL = "http://127.0.0.1:4050";

/** Upper bound for a bounded catalog invocation. The headless fallback may
 * compile (`go run`) or start a packaged binary; both must stay bounded so
 * shell startup and the CLI cannot hang on an unreachable backend. */
export const BOUNDED_CATALOG_TIMEOUT_MS = 20_000;

/** Resolve the devenv backend URL used for catalog reads. */
export function resolveCatalogBaseUrl(explicit?: string): string {
	return (
		explicit ??
		process.env.AGENTIC_DEVENV_URL ??
		process.env.DEVENV_URL ??
		DEFAULT_BASE_URL
	);
}

export interface ProjectCatalogOptions {
	baseUrl?: string;
	signal?: AbortSignal;
	fetchFn?: typeof fetch;
	/** Upper bound (ms) for the bounded headless invocation; defaults to
	 * `BOUNDED_CATALOG_TIMEOUT_MS`. Exposed so tests can bound a slow backend. */
	timeoutMs?: number;
}

/**
 * Fetch the canonical catalog over HTTP. Rejects with `ProjectCatalogError` on
 * failure; never falls back to scanning.
 */
export async function fetchProjectCatalog(
	options: ProjectCatalogOptions = {},
): Promise<ProjectCatalog> {
	const baseUrl = resolveCatalogBaseUrl(options.baseUrl);
	const fetchFn = options.fetchFn ?? (createCustomFetch() as typeof fetch);
	return requestProjectCatalog(
		{ baseUrl, fetchFn, sseFetchFn: fetchFn },
		options.signal,
	);
}

function serverBinaryName(): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return `devenv-${process.platform}-${process.arch}${suffix}`;
}

function repoRoot(): string {
	return path.resolve(import.meta.dir, "../../..");
}

interface BoundedInvocation {
	command: string[];
	cwd?: string;
}

/**
 * Locate the bounded `catalog` invocation of the backend executable. Prefers
 * an explicit override, then the imported server binary, then a development
 * `go run` against the source tree.
 */
export function resolveBoundedCatalogInvocation(): BoundedInvocation {
	const override = process.env.DEVENV_SERVER_BINARY;
	if (override) return { command: [override, "catalog"] };

	const root = repoRoot();
	// Prefer the current source tree in development so a stale packaged binary
	// cannot serve an outdated catalog projection.
	const serverDir = path.join(root, "server");
	if (fs.existsSync(path.join(serverDir, "main.go")))
		return { command: ["go", "run", "main.go", "catalog"], cwd: serverDir };

	const binariesDir = path.join(
		root,
		"agentic-coding",
		"packages",
		"devenv",
		"server-binaries",
	);
	const binary = path.join(binariesDir, serverBinaryName());
	if (fs.existsSync(binary)) return { command: [binary, "catalog"] };

	throw new ProjectCatalogError(
		"no devenv backend executable available for a bounded catalog invocation; set DEVENV_SERVER_BINARY",
		{ retryable: false },
	);
}

async function runBoundedCatalog(
	timeoutMs = BOUNDED_CATALOG_TIMEOUT_MS,
): Promise<ProjectCatalog> {
	const invocation = resolveBoundedCatalogInvocation();
	let stdout = "";
	let stderr = "";
	let exitCode = 1;
	let signalCode: string | null = null;
	try {
		const result = Bun.spawnSync(invocation.command, {
			cwd: invocation.cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
		});
		stdout = result.stdout?.toString() ?? "";
		stderr = result.stderr?.toString() ?? "";
		exitCode = result.exitCode ?? 1;
		signalCode = result.signalCode ?? null;
	} catch (error) {
		throw new ProjectCatalogError(
			`bounded catalog invocation failed to start: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ retryable: false },
		);
	}
	if (exitCode !== 0 || signalCode) {
		const timedOut = signalCode !== null;
		const detail =
			stderr.trim() || stdout.trim() || "catalog invocation failed";
		throw new ProjectCatalogError(
			timedOut
				? `bounded catalog invocation timed out after ${timeoutMs}ms`
				: `bounded catalog invocation failed: ${detail}`,
			{ retryable: timedOut },
		);
	}
	try {
		return JSON.parse(stdout) as ProjectCatalog;
	} catch (error) {
		throw new ProjectCatalogError(
			`bounded catalog invocation returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ retryable: false },
		);
	}
}

/**
 * Load the catalog for headless consumers: use the running managed server when
 * reachable, otherwise start a bounded read-only catalog invocation. This is
 * the canonical backend in both cases — configuration is never re-parsed into
 * a second discovery implementation.
 */
export async function loadProjectCatalog(
	options: ProjectCatalogOptions = {},
): Promise<ProjectCatalog> {
	try {
		return await fetchProjectCatalog(options);
	} catch (error) {
		if (error instanceof ProjectCatalogError && !error.retryable) throw error;
		if (options.signal?.aborted) throw error;
		return runBoundedCatalog(options.timeoutMs);
	}
}

/** Available canonical repository roots, de-duplicated and stable-sorted. */
export function projectCanonicalRoots(catalog: ProjectCatalog): string[] {
	const roots = new Set<string>();
	for (const project of catalog.projects) {
		if (project.available && project.canonicalRoot)
			roots.add(project.canonicalRoot);
	}
	return [...roots].sort();
}

/** Find the configured project that shares a canonical repository root. The
 * environment feature addresses a project by `ident`; workflow history and
 * telemetry address it by canonical root, so this is the stable cross-link. */
export function findProjectByCanonicalRoot(
	catalog: ProjectCatalog,
	root: string,
): CatalogProject | undefined {
	return catalog.projects.find((project) => project.canonicalRoot === root);
}

/** Find the configured project whose active or canonical checkout is `path`. */
export function findProjectByCheckout(
	catalog: ProjectCatalog,
	path: string,
): CatalogProject | undefined {
	return catalog.projects.find(
		(project) =>
			project.activeCheckout === path || project.canonicalRoot === path,
	);
}

/** Cross-link helper: resolve the stable configured ident for a repository or
 * checkout path used by workflow history/telemetry. Canonical roots are tried
 * first so a linked-worktree checkout still resolves to its project; it returns
 * undefined for repository-independent and unconfigured targets and never
 * retargets a pinned workflow checkout. */
export function projectIdentForPath(
	catalog: ProjectCatalog,
	path: string,
): string | undefined {
	return (
		findProjectByCanonicalRoot(catalog, path) ??
		findProjectByCheckout(catalog, path)
	)?.ident;
}

/** Diff catalog watcher registrations: stop removed roots, add new roots, and
 * leave unchanged roots (and the histories/active workflows they observe)
 * untouched. */
export function syncCatalogWatchers(
	watched: Map<string, () => void>,
	nextRoots: Iterable<string>,
	watch: (root: string) => () => void,
): void {
	const next = new Set(nextRoots);
	for (const [root, stop] of watched) {
		if (next.has(root)) continue;
		stop();
		watched.delete(root);
	}
	for (const root of next) {
		if (watched.has(root)) continue;
		watched.set(root, watch(root));
	}
}

/** Picker/CLI project option. The legacy `{ name, path, openspec }` keys are
 * preserved; availability is additive so consumers can refuse to start work on
 * a project that is not cloned instead of silently scanning elsewhere. */
export interface ProjectOption {
	name: string;
	path: string;
	openspec: boolean;
	ident: string;
	available: boolean;
	availability: CatalogProject["availability"];
	canonicalRoot?: string;
	activeCheckout?: string;
	detail?: string;
}

/** Project every configured catalog entry into the picker/CLI option shape. */
export function projectOptions(catalog: ProjectCatalog): ProjectOption[] {
	return catalog.projects.map((project) => ({
		name: project.displayName || project.ident,
		path: project.activeCheckout ?? project.canonicalRoot ?? "",
		openspec: project.capabilities.openspec,
		ident: project.ident,
		available: project.available,
		availability: project.availability,
		canonicalRoot: project.canonicalRoot,
		activeCheckout: project.activeCheckout,
		detail: project.detail,
	}));
}
