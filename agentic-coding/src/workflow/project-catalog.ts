// The single asynchronous configured-project catalog client. Workflow
// creation, workflow history, telemetry watch roots and CLI project listing
// all consume this boundary; no consumer re-scans directories or re-parses
// configuration on its own.
//
// A catalog request has three observable states the callers must keep apart:
//   • a valid catalog (possibly empty — a valid configuration state),
//   • a non-retryable configuration error (for example duplicate idents),
//   • a retryable transport/server failure.
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

/** Upper bound for a bounded catalog invocation: a second start of this same
 * executable must stay bounded, so shell startup and the CLI cannot hang. */
export const BOUNDED_CATALOG_TIMEOUT_MS = 20_000;

/**
 * Set by the shell while it is starting the backend it owns. A read that lands
 * in that window waits for the server instead of falling back to a bounded
 * invocation (which would spawn a second backend for one read); consumers that
 * never own a server leave it unset and fall back immediately.
 */
export const BACKEND_STARTING_ENV = "AGENTIC_DEVENV_STARTING";

const READY_RETRY_MS = 250;
const READY_RETRIES = 16;

/**
 * Resolve the server URL used for catalog reads.
 *
 * An empty result means "this process has no environment server to ask" — the
 * shell exports that for a route that owns no environment surface (dash, test,
 * headless reads), so a catalog read goes straight to the bounded read-only
 * invocation instead of guessing the default port, where another install could
 * be listening.
 */
export function resolveCatalogBaseUrl(explicit?: string): string {
	const resolved = explicit ?? process.env.AGENTIC_DEVENV_URL;
	if (resolved !== undefined) return resolved;
	return process.env.DEVENV_URL ?? DEFAULT_BASE_URL;
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

interface BoundedInvocation {
	command: string[];
	cwd?: string;
}

/**
 * Bounded read-only catalog invocation of *this* executable
 * (`agentic-coding __catalog`), which builds the same environment authority a
 * running server uses and prints the projection as JSON.
 *
 * A compiled binary re-execs itself with the internal mode as its argument; a
 * source run re-execs this package's CLI entry (never `Bun.main`, which is
 * whatever file the host process happened to start).
 */
function boundedCatalogArgv(): string[] {
	const compiled =
		Bun.main.startsWith("$bunfs") ||
		process.execPath.endsWith("agentic-coding");
	if (compiled) return [process.execPath, "__catalog"];
	return [
		process.execPath,
		path.resolve(import.meta.dir, "..", "cli.ts"),
		"__catalog",
	];
}

/** Run one bounded catalog command and parse its JSON. Exported so the bounded
 * invocation's failure/timeout classification is testable without a server. */
export async function spawnBoundedCatalog(
	invocation: BoundedInvocation,
	timeoutMs: number,
): Promise<ProjectCatalog> {
	let stdout = "";
	let stderr = "";
	let exitCode = 1;
	let signalCode: string | null = null;
	try {
		const result = Bun.spawnSync(invocation.command, {
			cwd: invocation.cwd,
			// Pass the environment explicitly: the child must see the roots this
			// process resolved (and any test/operator override), not a copy taken
			// before this process started.
			env: { ...process.env },
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

async function runBoundedCatalog(
	timeoutMs = BOUNDED_CATALOG_TIMEOUT_MS,
): Promise<ProjectCatalog> {
	// Outside a running server the catalog is read by a bounded invocation of
	// this same executable: one implementation of the projection, no second
	// runtime and no compiler in the loop.
	return spawnBoundedCatalog({ command: boundedCatalogArgv() }, timeoutMs);
}

/** Available canonical repository roots, de-duplicated and stable-sorted. */
/**
 * Load the catalog for headless consumers: use the running server when
 * reachable, otherwise start a bounded read-only catalog invocation of this
 * same executable. This is the canonical backend in both cases — configuration
 * is never re-parsed into a second discovery implementation.
 */
export async function loadProjectCatalog(
	options: ProjectCatalogOptions = {},
): Promise<ProjectCatalog> {
	// No address to ask: this process owns no environment surface.
	if (resolveCatalogBaseUrl(options.baseUrl) === "")
		return runBoundedCatalog(options.timeoutMs);
	const waitingForOwnedBackend =
		process.env[BACKEND_STARTING_ENV] === "1" && !options.signal?.aborted;
	const attempts = waitingForOwnedBackend ? READY_RETRIES : 0;
	for (let attempt = 0; ; attempt++) {
		try {
			return await fetchProjectCatalog(options);
		} catch (error) {
			if (error instanceof ProjectCatalogError && !error.retryable) throw error;
			if (options.signal?.aborted) throw error;
			// A transport failure while our own backend is still binding is a
			// readiness wait, not a missing-server case.
			if (attempt >= attempts) return runBoundedCatalog(options.timeoutMs);
			await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
		}
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
