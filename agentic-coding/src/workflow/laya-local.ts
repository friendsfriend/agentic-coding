// Managed local classifier sidecar (introduce-local-model-support-for-
// classification). The `laya-local` provider runs the `laya-system-one` INT8
// model fully offline: this module owns locating the package, acquiring the
// ~324 MB model on explicit request, spawning `laya-serve` on an ephemeral
// loopback port, and reporting health. It never reimplements inference.
//
// Division of labour: the `laya-system-one` dependency owns download,
// assembly, atomic writes and checksum verification (`resolveModel`); this
// module owns *when* that happens (only on an explicit install), where it lands
// (the app config root, overridable through `LAYA_*`), and the sidecar
// lifecycle. The transport half that turns the bound endpoint into a
// `ClassifierTarget` lives in `classifier-runner.ts`.
//
// A missing model or binary is never fatal to a workflow: the provider reports
// `unavailable` and the existing fail-open classifier behavior applies.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfigRoot } from "../config-root.ts";
import { ClassifierUnavailable } from "./failures.ts";

/** Install/acquire phase surfaced to the Settings modal. `idle` is "nothing
 * installed and nothing running"; a finished job reports `ready`, `failed`, or
 * `cancelled`. */
export type LayaInstallPhase =
	| "idle"
	| "acquiring"
	| "starting"
	| "ready"
	| "failed"
	| "cancelled";

/** Phase-level progress of the acquisition job. Byte-level progress is only
 * reported when the underlying resolver exposes it; the total comes from the
 * model manifest. */
export interface LayaInstallJob {
	readonly phase: LayaInstallPhase;
	readonly receivedBytes?: number;
	readonly totalBytes?: number;
	readonly detail?: string;
}

/** Non-secret local-classifier state for the status endpoint. */
export interface LayaLocalStatus {
	readonly installed: boolean;
	readonly running: boolean;
	readonly modelPath?: string;
	readonly bytes?: number;
	readonly binary?: string;
	readonly error?: string;
	readonly job?: LayaInstallJob;
}

/** A running sidecar: the loopback base URL and its shutdown. The sidecar is
 * bound to `127.0.0.1` and runs without a bearer credential: the dependency's
 * native server cannot be given one without pushing `--api-key` twice (a
 * dependency bug), so the start explicitly neutralizes any ambient
 * `LAYA_API_KEY`/`API_KEY` instead of adopting an unrelated secret. */
export interface LayaSidecar {
	readonly url: string;
	stop(): Promise<void>;
}

/** Resolved file locations and overrides. Every value is a path or an enum —
 * never a secret. */
export interface LayaLocalPaths {
	readonly installDir: string;
	readonly cacheDir: string;
	readonly explicitModelPath?: string;
	readonly explicitBinary?: string;
	readonly backend: string;
}

/** Injectables so the install state machine is testable without the model, the
 * network, or a spawned process. */
export interface LayaLocalDependencies {
	readonly paths: () => LayaLocalPaths;
	/** Acquire (and checksum-verify) `model.onnx`; the dependency owns atomicity. */
	readonly acquire: (input: {
		readonly paths: LayaLocalPaths;
		readonly signal: AbortSignal;
		readonly onPhase: (job: LayaInstallJob) => void;
	}) => Promise<{ path: string; bytes: number }>;
	/** Best-effort total download size for progress display. */
	readonly totalBytes: () => number | undefined;
	/** Start the sidecar against an already-installed model. */
	readonly start: (input: {
		readonly paths: LayaLocalPaths;
		readonly modelPath: string;
	}) => Promise<LayaSidecar>;
	/** Optional liveness probe of a bound sidecar URL. Absent means "assume
	 * alive" (test fakes), so a real deployment always provides it. */
	readonly isAlive?: (url: string) => Promise<boolean>;
	/** Optional checksum verification of a model file. Absent means "assume
	 * verified" (test fakes). */
	readonly verify?: (
		modelPath: string,
	) => Promise<{ ok: boolean; detail?: string }>;
}

const IN_FLIGHT_PHASES: readonly LayaInstallPhase[] = ["acquiring", "starting"];

/** How long `stop()` waits for an in-flight `ensureStarted` before it proceeds.
 * The epoch bump already invalidates that start, so a dependency that never
 * settles must not hold shutdown open; the wait exists only so the common case
 * (a start that is still verifying the model) finishes before the epoch check
 * would spawn a sidecar the shutdown then has to kill. */
const STOP_WAIT_MS = 5_000;

/** Race a pending operation against `STOP_WAIT_MS`, never rejecting. */
async function settledWithin(promise: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise.catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, STOP_WAIT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Pure path/override resolution. `LAYA_MODEL_PATH` names an assembled model,
 * `LAYA_CACHE_DIR` the cache, `LAYA_SERVE_BIN` the binary, and `LAYA_BACKEND`
 * the engine (`native` sharp, `wasm` fallback). */
export function layaLocalPaths(
	env: Readonly<Record<string, string | undefined>>,
	root: string,
): LayaLocalPaths {
	const installDir = path.join(root, "classifier", "laya");
	const value = (name: string): string | undefined => {
		const raw = env[name];
		return raw === undefined || raw === "" ? undefined : raw;
	};
	return {
		installDir,
		cacheDir: value("LAYA_CACHE_DIR") ?? installDir,
		...(value("LAYA_MODEL_PATH")
			? { explicitModelPath: value("LAYA_MODEL_PATH") }
			: {}),
		...(value("LAYA_SERVE_BIN")
			? { explicitBinary: value("LAYA_SERVE_BIN") }
			: {}),
		backend: value("LAYA_BACKEND") ?? "native",
	};
}

/** The model file the sidecar should load: the explicit override when it names
 * an existing file (or a directory containing `model.onnx`), otherwise the
 * acquired model under the install directory. */
export function installedModelPath(paths: LayaLocalPaths): string | undefined {
	const explicit = paths.explicitModelPath;
	if (explicit) {
		try {
			if (fs.statSync(explicit).isDirectory()) {
				// A directory override is only "installed" when it actually holds
				// `model.onnx`. Handing the engine a directory without one makes its
				// own resolver acquire the model over the network — a download the
				// user never confirmed.
				const inside = path.join(explicit, "model.onnx");
				return fs.existsSync(inside) ? inside : undefined;
			}
		} catch {
			/* missing override: report not-installed rather than a broken path */
		}
		return fs.existsSync(explicit) ? explicit : undefined;
	}
	const candidate = path.join(paths.installDir, "model.onnx");
	return fs.existsSync(candidate) ? candidate : undefined;
}

/** Explicit package-root override. The search below walks the executable's
 * neighbourhood, the working directory and Node resolution, and all three fail
 * when a compiled binary is copied out of the tree its `node_modules` live in.
 * This names the `laya-system-one` package directory directly for that case. */
export const LAYA_PACKAGE_ROOT_VAR = "LAYA_PACKAGE_ROOT";

/** What to tell an operator when the package cannot be located at all: the
 * failure is discovery, not installation, and the message says how to fix it. */
export function layaPackageRootHint(): string {
	return `laya-system-one could not be located; set ${LAYA_PACKAGE_ROOT_VAR} to its package directory when this executable runs outside its install tree`;
}

/** Locate the installed `laya-system-one` package.
 *
 * `bun build --compile` does not preserve `node_modules` resolution, so the
 * package cannot discover itself from `import.meta.url` inside the compiled
 * executable. The explicit override is consulted first, then the walk up from
 * the real executable path, then the working directory, then Node/Bun
 * resolution for a dev checkout. */
export function resolveLayaPackageRoot(options: {
	readonly execPath: string;
	readonly cwd?: string;
	readonly resolve?: (specifier: string) => string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): string | undefined {
	const found = (candidate: string): string | undefined => {
		try {
			const manifest = path.join(candidate, "package.json");
			if (!fs.existsSync(manifest)) return undefined;
			const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
				name?: unknown;
			};
			return parsed.name === "laya-system-one" ? candidate : undefined;
		} catch {
			return undefined;
		}
	};
	// A name that does not resolve to the real package is ignored rather than
	// trusted: the override must not become a way to hand this process an
	// arbitrary directory claiming to be the classifier runtime.
	const configured = (
		options.env?.[LAYA_PACKAGE_ROOT_VAR] ?? process.env[LAYA_PACKAGE_ROOT_VAR]
	)?.trim();
	if (configured) {
		const explicit = found(path.resolve(configured));
		if (explicit) return explicit;
	}
	let dir = path.dirname(safeRealpath(options.execPath));
	for (let depth = 0; depth < 10; depth++) {
		const candidate = found(path.join(dir, "node_modules", "laya-system-one"));
		if (candidate) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const cwdCandidate = found(
		path.join(options.cwd ?? process.cwd(), "node_modules", "laya-system-one"),
	);
	if (cwdCandidate) return cwdCandidate;
	try {
		const resolve =
			options.resolve ??
			createRequire(pathToFileURL(import.meta.url).href).resolve;
		// Validated like every other candidate: a resolver that answers with some
		// other directory must not be handed to the classifier as its runtime.
		return found(path.dirname(resolve("laya-system-one/package.json")));
	} catch {
		return undefined;
	}
}

function safeRealpath(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return candidate;
	}
}

/** The model manifest shipped with the package, or undefined when unreadable. */
export function layaModelManifest(
	packageRoot: string | undefined,
): { bytes?: number; model?: string; sha256?: string } | undefined {
	if (!packageRoot) return undefined;
	try {
		const parsed = JSON.parse(
			fs.readFileSync(
				path.join(packageRoot, "models", "model.manifest.json"),
				"utf8",
			),
		) as { bytes?: unknown; sha256?: unknown };
		return {
			...(typeof parsed.bytes === "number" ? { bytes: parsed.bytes } : {}),
			...(typeof parsed.sha256 === "string" ? { sha256: parsed.sha256 } : {}),
			model: "model.onnx",
		};
	} catch {
		return undefined;
	}
}

/** Metadata files the sidecar needs next to `model.onnx`. They ship with the
 * package; copying them makes the install self-contained so the sidecar can be
 * told one directory (which matters once the package is no longer on disk). */
const MODEL_ASSET_FILES = [
	"tokenizer.json",
	"tokenizer_config.json",
	"rl_agent_config.json",
	"model.manifest.json",
];

/** Stage the package's model metadata into the install directory. Existing
 * same-size files are left alone, so a resumed install does no extra work. */
export function stageModelAssets(
	packageRoot: string,
	installDir: string,
): void {
	const modelsDir = path.join(packageRoot, "models");
	fs.mkdirSync(installDir, { recursive: true });
	for (const name of MODEL_ASSET_FILES) {
		const source = path.join(modelsDir, name);
		const target = path.join(installDir, name);
		try {
			const sourceSize = fs.statSync(source).size;
			const targetSize = fs.existsSync(target) ? fs.statSync(target).size : -1;
			if (sourceSize === targetSize) continue;
			fs.copyFileSync(source, target);
		} catch {
			/* a missing asset surfaces when the sidecar starts, not here */
		}
	}
}

/** Remove temp files an interrupted acquisition may have left, without ever
 * touching an assembled `model.onnx`. The dependency streams to
 * `<model>.tmp-<pid>` and assembles chunks under `.chunks-<pid>/`, so those
 * shapes — not a bare `.tmp` suffix — are what must be matched. */
export function cleanLayaTempFiles(installDir: string): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(installDir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const isTemp =
			/t\.tmp-\d+$/.test(entry) ||
			entry.includes(".tmp-") ||
			entry.startsWith(".chunks-") ||
			entry.startsWith(".write-probe-") ||
			entry.endsWith(".partial");
		if (!isTemp) continue;
		try {
			fs.rmSync(path.join(installDir, entry), { recursive: true, force: true });
		} catch {
			/* a locked/foreign temp file must not turn cancel into a route error */
		}
	}
}

/** The real dependencies: the `laya-system-one` package resolved from the
 * install root and dynamically imported so a compiled executable never needs
 * its `import.meta.url` asset lookups at module load. */
export function realLayaLocalDependencies(
	env: Readonly<Record<string, string | undefined>> = process.env,
	root: string = resolveConfigRoot(),
): LayaLocalDependencies {
	const packageRoot = () =>
		resolveLayaPackageRoot({
			execPath: process.execPath,
			cwd: process.cwd(),
			env,
		});
	const importer = async <T>(rootDir: string, relative: string): Promise<T> =>
		(await import(pathToFileURL(path.join(rootDir, relative)).href)) as T;
	return {
		paths: () => layaLocalPaths(env, root),
		totalBytes: () => layaModelManifest(packageRoot())?.bytes,
		isAlive: async (url) => {
			try {
				const response = await fetch(new URL("/health", url), {
					signal: AbortSignal.timeout(2_000),
				});
				return response.ok;
			} catch {
				return false;
			}
		},
		verify: async (modelPath) => {
			const rootDir = packageRoot();
			// An unresolvable package is reported as discovery, so the operator is told
			// what to fix instead of reading it as a corrupt install.
			if (!rootDir) return { ok: false, detail: layaPackageRootHint() };
			const expected = layaModelManifest(rootDir)?.sha256;
			if (!expected)
				// A control that silently becomes a no-op is worse than a refusal: do
				// not serve a model whose expected digest cannot be established.
				return {
					ok: false,
					detail:
						"the local classifier manifest has no expected checksum; refusing to serve an unverified model",
				};
			const sidecar = `${modelPath}.sha256`;
			// Only cache a digest next to a model we own; a foreign `LAYA_MODEL_PATH`
			// directory stays untouched.
			const cacheSidecar = modelPath.startsWith(
				`${layaLocalPaths(env, root).installDir}${path.sep}`,
			);
			try {
				if (
					cacheSidecar &&
					fs.readFileSync(sidecar, "utf8").trim() === expected
				)
					return { ok: true };
			} catch {
				/* no sidecar: hash once below */
			}
			// The package root was already resolved above, so the resolver import is
			// reachable.
			const { sha256File } = await importer<{
				sha256File: (file: string) => Promise<string>;
			}>(rootDir, "src/model-resolver.js");
			const actual = await sha256File(modelPath).catch(() => undefined);
			if (actual !== expected)
				return {
					ok: false,
					detail: "the local classifier model failed checksum verification",
				};
			// A read-only model directory must not turn a matching digest into a
			// failed verification.
			if (cacheSidecar) {
				try {
					fs.writeFileSync(sidecar, expected, { mode: 0o600 });
				} catch {
					/* re-hash next time */
				}
			}
			return { ok: true };
		},
		acquire: async ({ paths, onPhase }) => {
			const rootDir = packageRoot();
			if (!rootDir)
				throw new Error(
					`${layaPackageRootHint()}; the local classifier model cannot be acquired`,
				);
			fs.mkdirSync(paths.installDir, { recursive: true });
			stageModelAssets(rootDir, paths.installDir);
			onPhase({ phase: "acquiring", detail: "Downloading and verifying" });
			const resolver = await importer<{
				resolveModel: (options: Record<string, unknown>) => Promise<{
					path: string;
				}>;
			}>(rootDir, "src/model-resolver.js");
			// `resolveModel` exposes no cancellation hook, so this deliberately does
			// not race the abort: the caller owns cancellation via
			// `LayaLocalClassifier`'s `raceAbort`, which also attaches a late-arrival
			// cleanup so an abandoned download cannot materialise a model.
			const acquired = await resolver.resolveModel({
				modelDir: paths.installDir,
				cacheDir: paths.cacheDir,
				quiet: true,
			});
			const bytes = fs.statSync(acquired.path).size;
			return { path: acquired.path, bytes };
		},
		start: async ({ paths, modelPath }) => {
			const rootDir = packageRoot();
			if (!rootDir)
				throw new Error(
					`${layaPackageRootHint()}; the local classifier cannot start`,
				);
			const binary = paths.explicitBinary ?? resolveSidecarBinary(rootDir);
			// Both variables are read only by the dependency/the child at spawn
			// time, so the hand-off is scoped: set them for the spawn, then restore,
			// so neither leaks into every later agent/git child and `status().binary`
			// keeps reporting only an explicitly configured value.
			const previous = {
				bin: process.env.LAYA_SERVE_BIN,
				layaKey: process.env.LAYA_API_KEY,
				apiKey: process.env.API_KEY,
			};
			if (binary) process.env.LAYA_SERVE_BIN = binary;
			// The dependency would silently require a bearer credential whenever an
			// ambient `LAYA_API_KEY` (or the common, unrelated `API_KEY`) is set, and
			// its own proxy would then fail without it. Neutralize both for the spawn
			// so the loopback sidecar stays credential-free and an unrelated variable
			// cannot toggle authentication on.
			delete process.env.LAYA_API_KEY;
			delete process.env.API_KEY;
			try {
				const server = await importer<{
					serve: (options: Record<string, unknown>) => Promise<{
						url: string;
						close: () => Promise<void>;
					}>;
				}>(rootDir, "src/server.js");
				const handle = await server.serve({
					host: "127.0.0.1",
					port: 0,
					modelDir: path.dirname(modelPath),
					backend: paths.backend,
				});
				return {
					url: handle.url,
					stop: async () => void (await handle.close()),
				};
			} finally {
				if (previous.bin === undefined) delete process.env.LAYA_SERVE_BIN;
				else process.env.LAYA_SERVE_BIN = previous.bin;
				if (previous.layaKey === undefined) delete process.env.LAYA_API_KEY;
				else process.env.LAYA_API_KEY = previous.layaKey;
				if (previous.apiKey === undefined) delete process.env.API_KEY;
				else process.env.API_KEY = previous.apiKey;
			}
		},
	};
}

/** Locate the bundled `laya-serve` binary under the resolved package root so a
 * compiled executable (where the dependency cannot self-discover) still starts
 * the sidecar. npm and Bun do not preserve the executable bit and a blocked
 * postinstall never restores it, so the mode is fixed here: setting
 * `LAYA_SERVE_BIN` ourselves bypasses the dependency's own executable-bit fix. */
export function resolveSidecarBinary(packageRoot: string): string | undefined {
	const platform = process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const exe = platform === "win32" ? "laya-serve.exe" : "laya-serve";
	const scope = path.join(packageRoot, "..", "@sys-one");
	const candidates: string[] = [];
	try {
		for (const entry of fs.readdirSync(scope)) {
			if (!entry.startsWith("laya-serve-")) continue;
			candidates.push(
				path.join(scope, entry, "bin", `${platform}-${arch}`, exe),
			);
		}
	} catch {
		return undefined;
	}
	for (const candidate of candidates)
		if (fs.existsSync(candidate)) return restoreExecutableBit(candidate);
	return undefined;
}

/** Restore the executable bit a blocked postinstall would have set. */
function restoreExecutableBit(bin: string): string {
	if (process.platform === "win32") return bin;
	try {
		const mode = fs.statSync(bin).mode;
		if ((mode & 0o111) === 0) fs.chmodSync(bin, mode | 0o755);
	} catch {
		/* read-only fs: the spawn surfaces a clear error */
	}
	return bin;
}

function abortError(): Error {
	const error = new Error("local classifier install cancelled");
	error.name = "AbortError";
	return error;
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	);
}

/** The managed sidecar + acquisition state machine. One instance per process:
 * the model is process-global, so a second install would race the first. */
export class LayaLocalClassifier {
	readonly #deps: LayaLocalDependencies;
	#sidecar: LayaSidecar | undefined;
	#sidecarModelPath: string | undefined;
	/** The spawn currently in flight, if any (the inner single-flight). */
	#starting: Promise<void> | undefined;
	/** The whole `ensureStarted` currently in flight, if any. The front half (a
	 * liveness probe and a full-file checksum) is expensive, so concurrent
	 * launches share one operation rather than each repeating it; `stop()` awaits
	 * this so a start this process requested cannot spawn a sidecar after
	 * shutdown resolved. */
	#ensuring: Promise<void> | undefined;
	#model: { path: string; bytes: number } | undefined;
	/** The install run currently unwinding, if any. A run object is the only thing
	 * that clears itself, so a stale `finally` can never clear a newer run. */
	#run: { generation: number; controller: AbortController } | undefined;
	#generation = 0;
	#job: LayaInstallJob = { phase: "idle" };
	#error: string | undefined;

	constructor(deps: LayaLocalDependencies) {
		this.#deps = deps;
	}

	/** The bound sidecar base URL, or undefined when it is not running. */
	endpoint(): string | undefined {
		return this.#sidecar?.url;
	}

	/** The loopback System One endpoint of the running sidecar. */
	systemOneUrl(): string | undefined {
		const base = this.endpoint();
		return base ? `${base}/v1/systemone` : undefined;
	}

	status(): LayaLocalStatus {
		const paths = this.#deps.paths();
		const installed = this.#model ?? this.#installedOnDisk(paths);
		const binary = paths.explicitBinary;
		return {
			installed: installed !== undefined,
			running: this.endpoint() !== undefined,
			...(installed
				? { modelPath: installed.path, bytes: installed.bytes }
				: {}),
			...(binary ? { binary } : {}),
			...(this.#error ? { error: this.#error } : {}),
			job: this.#job,
		};
	}

	/** Non-secret liveness, probing the bound sidecar instead of trusting the
	 * handle: a killed `laya-serve` must report `unavailable`, not `ready`. */
	async health(): Promise<{
		readonly state: "ready" | "starting" | "unavailable";
		readonly detail?: string;
	}> {
		const handle = this.#sidecar;
		if (handle) {
			if (await this.#alive(handle.url)) {
				// A stop inside the probe window leaves the handle cleared; only the
				// handle we actually probed may report ready.
				if (this.#sidecar === handle) return { state: "ready" };
			}
			return {
				state: "unavailable",
				detail: this.#error ?? "the local classifier sidecar is not responding",
			};
		}
		if (
			this.#run ||
			this.#starting ||
			IN_FLIGHT_PHASES.includes(this.#job.phase)
		)
			return { state: "starting" };
		return {
			state: "unavailable",
			...(this.#error ? { detail: this.#error } : {}),
		};
	}

	/** Acquire (if needed) and start the sidecar. Idempotent: a call while a run
	 * is unwinding returns its job instead of starting a second acquisition. */
	async install(): Promise<LayaInstallJob> {
		if (this.#run) return this.#job;
		const paths = this.#deps.paths();
		const run = {
			generation: ++this.#generation,
			controller: new AbortController(),
			hadInstalledBefore: installedModelPath(paths) !== undefined,
			acquired: undefined as { path: string; bytes: number } | undefined,
			// State owned before the run: `#abandon` must undo only what this run
			// created, never a healthy sidecar/model that already existed.
			ownedModel: this.#model,
			ownedSidecar: this.#sidecar,
		};
		this.#run = run;
		this.#error = undefined;
		this.#job = { phase: "acquiring", totalBytes: this.#deps.totalBytes() };
		const stale = () =>
			run.generation !== this.#generation || run.controller.signal.aborted;
		try {
			const acquire = this.#deps.acquire({
				paths,
				signal: run.controller.signal,
				onPhase: (job) => {
					if (!stale())
						this.#job = { ...job, totalBytes: this.#deps.totalBytes() };
				},
			});
			// The dependency cannot cancel its own download, so an abandoned
			// acquisition may still settle and write the model after the abort. Remove
			// what it wrote — but only when no surviving run has adopted that model, so
			// a cancelled run can never delete a later, successful install's file.
			void acquire
				.then((late) => {
					if (!stale() || run.hadInstalledBefore) return;
					if (this.#model?.path === late.path) return;
					if (installedModelPath(this.#deps.paths()) === late.path) return;
					removeFile(late.path);
					removeFile(`${late.path}.sha256`);
				})
				.catch(() => {});
			const acquired = await raceAbort(acquire, run.controller.signal);
			run.acquired = acquired;
			if (stale()) return this.#abandon(run);
			const verified = await this.#verifyModel(acquired.path);
			if (stale()) return this.#abandon(run);
			if (!verified.ok)
				throw new ClassifierUnavailable(
					verified.detail ?? "the local classifier model failed verification",
				);
			this.#model = acquired;
			this.#job = { phase: "starting", totalBytes: this.#deps.totalBytes() };
			await this.#startSidecar(paths, acquired.path, run.generation);
			// A stop/heal may have superseded this run while the sidecar started.
			if (stale() || !this.#ownsSidecarFor(run, acquired.path))
				return this.#abandon(run);
			return this.#settle({ phase: "ready" }, paths);
		} catch (error) {
			if (stale() || isAbort(error)) return this.#abandon(run);
			const detail = error instanceof Error ? error.message : String(error);
			return this.#settle({ phase: "failed", detail }, paths, detail);
		} finally {
			if (this.#run === run) this.#run = undefined;
		}
	}

	/** Cancel the in-flight run: stop it at the next await boundary, drop the
	 * model it may have written, and clean any temp file it left. */
	async cancel(): Promise<void> {
		const run = this.#run;
		if (!run) return;
		run.controller.abort();
		// Bump the generation so the run treats itself as stale even if its
		// controller is replaced later.
		this.#generation += 1;
		const paths = this.#deps.paths();
		this.#job = { phase: "cancelled" };
		cleanLayaTempFiles(paths.installDir);
	}

	/** Start the sidecar for an already-installed model. Never acquires: the
	 * `laya-local` provider must stay offline until the user installs. Concurrent
	 * callers share one attempt: the probe, the verification and the spawn all
	 * happen once per wave, and the shared promise is dropped as soon as it
	 * settles so a later caller retries a failure. */
	async ensureStarted(): Promise<void> {
		const inFlight = this.#ensuring;
		if (inFlight) return inFlight;
		const promise = this.#ensureStartedOnce();
		this.#ensuring = promise;
		try {
			await promise;
		} finally {
			if (this.#ensuring === promise) this.#ensuring = undefined;
		}
	}

	async #ensureStartedOnce(): Promise<void> {
		// Capture the epoch synchronously, before any await: a `stop()` that lands
		// while this start is being prepared must supersede it.
		const epoch = this.#generation;
		const paths = this.#deps.paths();
		if (this.#sidecar?.url) {
			const handle = this.#sidecar;
			if (await this.#alive(handle.url)) {
				// A stop that landed inside the probe window already cleared the
				// handle; do not report success for a sidecar that is gone.
				if (this.#sidecar === handle && epoch === this.#generation) return;
			}
		}
		if (this.#sidecar) {
			// A dead sidecar is replaced, not trusted: clear the handle so a killed
			// process is reported unavailable and respawned.
			const dead = this.#sidecar;
			this.#sidecar = undefined;
			this.#sidecarModelPath = undefined;
			void dead.stop().catch(() => {});
		}
		const model =
			this.#model ??
			this.#installedOnDisk(paths) ??
			this.#requireInstalled(paths);
		const verified = await this.#verifyModel(model.path);
		if (!verified.ok) {
			this.#error =
				verified.detail ?? "the local classifier model failed verification";
			throw new ClassifierUnavailable(this.#error);
		}
		try {
			await this.#startSidecar(paths, model.path, epoch);
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			throw error instanceof ClassifierUnavailable
				? error
				: new ClassifierUnavailable(this.#error);
		}
		if (epoch !== this.#generation)
			throw new ClassifierUnavailable(
				"the local classifier start was superseded by a stop",
			);
		this.#model = model;
		this.#error = undefined;
		if (!IN_FLIGHT_PHASES.includes(this.#job.phase))
			this.#job = { phase: "ready" };
	}

	async stop(): Promise<void> {
		// Supersede any pending start and any in-flight install so neither can
		// publish a sidecar or a `ready` job after this stop.
		this.#generation += 1;
		this.#run?.controller.abort();
		// Await the whole pending start, not only the spawn: a start that is still
		// verifying the model has not reached `#starting` yet, and would otherwise
		// spawn a sidecar after this stop resolved. Bounded, because the epoch bump
		// above already invalidates it.
		const ensuring = this.#ensuring;
		if (ensuring) await settledWithin(ensuring);
		const starting = this.#starting;
		if (starting) await starting.catch(() => {});
		const sidecar = this.#sidecar;
		this.#sidecar = undefined;
		this.#sidecarModelPath = undefined;
		if (sidecar) await sidecar.stop().catch(() => {});
	}

	#requireInstalled(paths: LayaLocalPaths): { path: string; bytes: number } {
		const installed = this.#installedOnDisk(paths);
		if (installed) return installed;
		throw new ClassifierUnavailable(
			"the local classifier model is not installed; install it before selecting laya-local",
		);
	}

	#installedOnDisk(
		paths: LayaLocalPaths,
	): { path: string; bytes: number } | undefined {
		const candidate = installedModelPath(paths);
		return candidate
			? { path: candidate, bytes: fileSize(candidate) }
			: undefined;
	}

	/** True when the sidecar currently published is the one this run started. */
	#ownsSidecarFor(run: { generation: number }, modelPath: string): boolean {
		return (
			this.#sidecar !== undefined &&
			this.#sidecarModelPath === modelPath &&
			run.generation === this.#generation
		);
	}

	/** Undo a cancelled/superseded run without touching state the run did not
	 * create: a cancel must never mean "installed", never delete a pre-existing
	 * model, and never tear down a healthy sidecar it did not start. */
	#abandon(run: {
		readonly hadInstalledBefore: boolean;
		readonly acquired?: { path: string } | undefined;
		readonly ownedModel: { path: string; bytes: number } | undefined;
		readonly ownedSidecar: LayaSidecar | undefined;
	}): LayaInstallJob {
		if (this.#model && this.#model !== run.ownedModel)
			this.#model = run.ownedModel;
		const current = this.#sidecar;
		if (current && current !== run.ownedSidecar) {
			this.#sidecar = run.ownedSidecar;
			this.#sidecarModelPath = undefined;
			void current.stop().catch(() => {});
		}
		if (run.acquired && !run.hadInstalledBefore) {
			removeFile(run.acquired.path);
			removeFile(`${run.acquired.path}.sha256`);
		}
		if (this.#job.phase !== "cancelled") this.#job = { phase: "cancelled" };
		return this.#job;
	}

	async #verifyModel(
		modelPath: string,
	): Promise<{ ok: boolean; detail?: string }> {
		const verify = this.#deps.verify;
		if (!verify) return { ok: true };
		try {
			return await verify(modelPath);
		} catch (error) {
			return {
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async #alive(url: string): Promise<boolean> {
		const isAlive = this.#deps.isAlive;
		if (!isAlive) return true;
		try {
			return await isAlive(url);
		} catch {
			return false;
		}
	}

	/** Single-flight start: concurrent callers share one spawn, so a classifier
	 * call and a provider switch cannot leave two `laya-serve` processes. The
	 * `epoch` is captured by the caller before its first await, so a `stop()`
	 * that lands while the start is being prepared still supersedes it. */
	async #startSidecar(
		paths: LayaLocalPaths,
		modelPath: string,
		epoch: number,
	): Promise<void> {
		if (this.#sidecar && this.#sidecarModelPath === modelPath) return;
		const inFlight = this.#starting;
		if (inFlight) {
			await inFlight.catch(() => {});
			if (this.#sidecar && this.#sidecarModelPath === modelPath) return;
		}
		const promise = this.#doStartSidecar(paths, modelPath, epoch);
		this.#starting = promise;
		try {
			await promise;
		} finally {
			if (this.#starting === promise) this.#starting = undefined;
		}
	}

	async #doStartSidecar(
		paths: LayaLocalPaths,
		modelPath: string,
		epoch: number,
	): Promise<void> {
		const previous = this.#sidecar;
		this.#sidecar = undefined;
		this.#sidecarModelPath = undefined;
		if (previous) await previous.stop().catch(() => {});
		const handle = await this.#deps.start({ paths, modelPath });
		if (epoch !== this.#generation) {
			await handle.stop().catch(() => {});
			return;
		}
		if (this.#sidecar && this.#sidecar !== handle) {
			await handle.stop().catch(() => {});
			return;
		}
		this.#sidecar = handle;
		this.#sidecarModelPath = modelPath;
	}

	#settle(
		job: LayaInstallJob,
		paths: LayaLocalPaths,
		error?: string,
	): LayaInstallJob {
		this.#job = {
			...job,
			...(this.#deps.totalBytes() !== undefined
				? { totalBytes: this.#deps.totalBytes() }
				: {}),
		};
		if (error !== undefined) this.#error = error;
		if (job.phase === "ready") {
			const model = this.#model ?? this.#installedOnDisk(paths);
			if (model) this.#model = model;
			this.#error = undefined;
		}
		return this.#job;
	}
}

/** Reject as soon as `signal` aborts, without abandoning the underlying promise
 * (the caller attaches its own late-arrival cleanup). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError());
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function fileSize(candidate: string): number {
	try {
		return fs.statSync(candidate).size;
	} catch {
		return 0;
	}
}

function removeFile(candidate: string): void {
	try {
		fs.rmSync(candidate, { force: true });
	} catch {
		/* a locked file is cleaned on the next cancel/start */
	}
}

let instance: LayaLocalClassifier | undefined;

/** The process-wide local classifier. Built lazily so importing the provider
 * catalog never resolves the config root or touches the filesystem. */
export function layaLocalClassifier(): LayaLocalClassifier {
	instance ??= new LayaLocalClassifier(realLayaLocalDependencies());
	return instance;
}

/** Replace the process-wide instance (tests, or a composition root that owns a
 * different configuration root). Passing undefined restores the default. */
export function setLayaLocalClassifier(
	replacement?: LayaLocalClassifier,
): void {
	instance = replacement;
}
