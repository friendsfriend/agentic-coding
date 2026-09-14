// Effect-native managed-backend boundary: the Go environment backend this
// process spawns, proves ownership of, and stops.
//
// Conventions (docs/workflow-effect.md): expected failures are concrete
// `Data.TaggedError` values, native/Promise I/O lives behind one service
// (`BackendRuntime`), acquisition/release is `Effect.acquireRelease` so a
// partial startup unwinds exactly what it acquired, and no program here runs
// its own Effect runtime — `src/backend/lifecycle.ts` is the named
// composition root.
//
// Ownership is proved by identity, never by a listening port: the child is
// spawned with a random instance id and only counts as ours when health
// reports that id, this process's home directory and the same config
// directory. A port served by anybody else is reported, never signalled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scope } from "effect";
import { Context, Data, Effect, Layer } from "effect";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Embedded backend binary (base64) — defined at compile time. */
declare const EMBEDDED_SERVER_BINARY_BASE64: string | undefined;

export type BackendFailureReason =
	| "binary-missing"
	| "extraction-failed"
	| "spawn-failed"
	| "port-conflict"
	| "identity-mismatch"
	| "not-ready";

/** Every expected startup failure. `reason` is the stable external code. */
export class BackendStartupError extends Data.TaggedError(
	"BackendStartupError",
)<{
	readonly reason: BackendFailureReason;
	readonly detail: string;
}> {
	get message(): string {
		return `${this.reason}: ${this.detail}`;
	}
}

export class BackendStopError extends Data.TaggedError("BackendStopError")<{
	readonly detail: string;
	readonly timedOut: boolean;
}> {
	get message(): string {
		return this.detail;
	}
}

export interface BackendHealth {
	status?: string;
	homeDir?: string;
	configDir?: string;
	instance?: string;
	version?: string;
	pid?: string;
}

export interface BackendIdentity {
	instance: string;
	homeDir: string;
	configDir: string;
}

export interface ResolvedBinary {
	/** Binary to exec, or null when the dev route runs `go run` from source. */
	path: string | null;
	isEmbedded: boolean;
	isDevMode: boolean;
}

/** One spawned child. Structural so tests can substitute a fake process. */
export interface BackendChild {
	readonly pid: number | undefined;
	readonly exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
	isRunning(): boolean;
}

export interface BackendRuntimeShape {
	/** Read the health document, or `undefined` when nothing answers. */
	readonly probe: (
		serverUrl: string,
	) => Effect.Effect<BackendHealth | undefined>;
	/** Resolve the embedded/packaged/source backend for this launch. */
	readonly resolveBinary: (
		instance: string,
	) => Effect.Effect<ResolvedBinary, BackendStartupError>;
	readonly spawnBackend: (options: {
		port: string;
		instance: string;
		binary: ResolvedBinary;
		homeDir: string;
		/** Private instance capability the child requires on every non-health
		 * route (expose-unified-bun-backend, task 1.3). */
		token: string;
	}) => Effect.Effect<BackendChild, BackendStartupError, BackendRuntime>;
	/** Remove the private extraction directory an instance owned. */
	readonly removeExtractionDir: (instance: string) => Effect.Effect<void>;
}

export class BackendRuntime extends Context.Tag("workflow/BackendRuntime")<
	BackendRuntime,
	BackendRuntimeShape
>() {}

// ---- Pure identity/config helpers ----

function parseEnvFile(filePath: string): Record<string, string> {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const vars: Record<string, string> = {};
		for (const raw of content.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const stripped = line.replace(/^export\s+/, "");
			const eq = stripped.indexOf("=");
			if (eq === -1) continue;
			const key = stripped.slice(0, eq).trim();
			let value = stripped
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			value = value.replace(/\$\{HOME\}|\$HOME/g, os.homedir());
			if (key) vars[key] = value;
		}
		return vars;
	} catch {
		return {};
	}
}

export function resolveConfigDir(): string {
	if (process.env.DEVENV_CONFIG_DIR) return process.env.DEVENV_CONFIG_DIR;
	return path.join(os.homedir(), ".config", "devenv");
}

export function resolveDevenvHome(): string {
	if (process.env.DEVENV_HOME) return process.env.DEVENV_HOME;
	const configDir = resolveConfigDir();
	const envVars = parseEnvFile(path.join(configDir, ".env"));
	if (envVars.DEVENV_HOME) return envVars.DEVENV_HOME;
	return path.join(os.homedir(), "devenv");
}

/** Random per-launch identity. Web Crypto is a Bun global. */
export function newInstanceId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

/** Random per-launch private capability presented to the Go child. */
export function newInstanceToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
}

/** Private per-instance extraction directory (mode 0700). */
export function extractionDir(instance: string): string {
	return path.join(os.tmpdir(), `agentic-coding-backend-${instance}`);
}

export function expectedIdentity(instance: string): BackendIdentity {
	return {
		instance,
		homeDir: resolveDevenvHome(),
		configDir: resolveConfigDir(),
	};
}

/** Every field that must match before a listener counts as our own child. */
export function healthMatches(
	health: BackendHealth,
	expected: BackendIdentity,
): boolean {
	return (
		health.status === "ok" &&
		health.instance === expected.instance &&
		health.homeDir === expected.homeDir &&
		health.configDir === expected.configDir
	);
}

export function backendUrl(port: string): string {
	return `http://127.0.0.1:${port}`;
}

// ---- Executable resolution (shared by the managed start and by the bounded
// catalog invocation of the same backend) ----

/**
 * Absolute path of the backend executable to run.
 *
 * The development route has no packaged binary yet, so it builds the source
 * tree into `dist/server/devenv` — the same location the packaged fallback
 * looks for, so the build happens once and later runs reuse it. `go run` is
 * deliberately not used: it makes the Go program a grandchild of a wrapper
 * this process does not own, so stopping the child could leave the real
 * listener running.
 */
export const ensureExecutable = (
	binary: ResolvedBinary,
): Effect.Effect<string, BackendStartupError> =>
	Effect.gen(function* () {
		if (binary.path && !binary.isDevMode) return binary.path;
		const projectRoot = path.resolve(__dirname, "../..");
		const devBinary = path.join(
			projectRoot,
			"dist",
			"server",
			process.platform === "win32" ? "devenv.exe" : "devenv",
		);
		yield* Effect.tryPromise({
			try: async () => {
				await fs.promises.mkdir(path.dirname(devBinary), {
					recursive: true,
					mode: 0o700,
				});
				const build = Bun.spawnSync(
					["go", "build", "-ldflags", devLdflags(), "-o", devBinary, "."],
					{ cwd: path.resolve(projectRoot, "server") },
				);
				if (build.exitCode !== 0)
					throw new Error(
						build.stderr.toString().trim() ||
							`go build exited ${build.exitCode}`,
					);
			},
			catch: (error) =>
				new BackendStartupError({
					reason: "binary-missing",
					detail: `could not build the environment backend from source: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}),
		});
		return devBinary;
	});

/** Version injection for a source-tree build, from the one version source. */
function devLdflags(): string {
	let version = "0.0.0";
	try {
		version =
			(
				JSON.parse(
					fs.readFileSync(
						path.resolve(__dirname, "../../package.json"),
						"utf8",
					),
				) as { version?: string }
			).version ?? "0.0.0";
	} catch {}
	return `-X github.com/friendsfriend/devenv/pkg/version.Version=${version}`;
}

// ---- Live boundary implementation ----

function extractEmbedded(
	instance: string,
): Effect.Effect<string | null, BackendStartupError> {
	if (
		typeof EMBEDDED_SERVER_BINARY_BASE64 === "undefined" ||
		!EMBEDDED_SERVER_BINARY_BASE64
	)
		return Effect.succeed(null);
	const dir = extractionDir(instance);
	return Effect.tryPromise({
		try: async () => {
			try {
				await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
				await fs.promises.chmod(dir, 0o700);
				const extension = process.platform === "win32" ? ".exe" : "";
				const binaryPath = path.join(dir, `devenv-server${extension}`);
				await Bun.write(
					binaryPath,
					Buffer.from(EMBEDDED_SERVER_BINARY_BASE64, "base64"),
				);
				if (process.platform !== "win32")
					await fs.promises.chmod(binaryPath, 0o700);
				if (process.platform === "darwin") {
					try {
						Bun.spawnSync(["codesign", "--remove-signature", binaryPath]);
						Bun.spawnSync(["codesign", "-s", "-", binaryPath]);
					} catch {}
				}
				return binaryPath;
			} catch (error) {
				// Failure cleanup: never leave a half-extracted binary behind.
				await fs.promises
					.rm(dir, { recursive: true, force: true })
					.catch(() => {});
				throw error;
			}
		},
		catch: (error) =>
			new BackendStartupError({
				reason: "extraction-failed",
				detail: error instanceof Error ? error.message : String(error),
			}),
	});
}

export const BackendRuntimeLive = Layer.succeed(BackendRuntime, {
	probe: (serverUrl) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(`${serverUrl}/api/health`, {
					signal: AbortSignal.timeout(1000),
				});
				if (!response.ok) throw new Error(`health ${response.status}`);
				return (await response.json()) as BackendHealth;
			},
			catch: () => undefined,
		}).pipe(Effect.catchAll(() => Effect.succeed(undefined))),

	resolveBinary: (instance) =>
		Effect.gen(function* () {
			const embeddedPath = yield* extractEmbedded(instance);
			if (embeddedPath) {
				const resolved: ResolvedBinary = {
					path: embeddedPath,
					isEmbedded: true,
					isDevMode: false,
				};
				return resolved;
			}
			const projectRoot = path.resolve(__dirname, "../..");
			const distBinaryPath = path.join(projectRoot, "dist/server/devenv");
			const exists = yield* Effect.promise(() =>
				Bun.file(distBinaryPath).exists(),
			);
			const resolved: ResolvedBinary = exists
				? { path: distBinaryPath, isEmbedded: false, isDevMode: false }
				: { path: null, isEmbedded: false, isDevMode: true };
			return resolved;
		}),

	spawnBackend: ({ port, instance, binary, homeDir, token }) =>
		Effect.gen(function* () {
			const executable = yield* ensureExecutable(binary);
			const logDir = path.join(homeDir, "logs");
			yield* Effect.promise(() =>
				fs.promises.mkdir(logDir, { recursive: true }),
			);
			const logFile = yield* Effect.promise(() =>
				fs.promises.open(path.join(logDir, "server.log"), "a"),
			);
			const child = Bun.spawn(
				[executable, "server", "--port", port, "--instance", instance],
				{
					stdout: logFile.fd,
					stderr: logFile.fd,
					env: { ...process.env, DEVENV_INSTANCE_TOKEN: token },
				},
			);
			// The log handle belongs to the child, not to this effect.
			yield* Effect.promise(() => logFile.close());
			return {
				pid: child.pid,
				exited: child.exited,
				kill: (signal?: NodeJS.Signals) => {
					try {
						child.kill(signal);
					} catch {}
				},
				isRunning: () => child.exitCode === null,
			} satisfies BackendChild;
		}),

	removeExtractionDir: (instance) =>
		Effect.promise(() =>
			fs.promises
				.rm(extractionDir(instance), { recursive: true, force: true })
				.catch(() => {}),
		),
});

// ---- Startup / release programs ----

export interface OwnedBackend {
	readonly port: string;
	readonly url: string;
	readonly instance: string;
	readonly pid: number | undefined;
	/** Private capability the child now requires on non-health routes. */
	readonly token: string;
}

export interface StartBackendOptions {
	readonly port: string;
	readonly instance?: string;
	/** Private capability; generated when omitted. */
	readonly token?: string;
	/** Readiness poll attempts (500ms apart); overridable in tests. */
	readonly readinessRetries?: number;
	/** Bounded wait for the child to exit after SIGTERM/SIGKILL. */
	readonly stopTimeoutMs?: number;
}

const READY_POLL_MS = 500;

/** Stop the child this process spawned, bounded, then remove its extraction
 * directory. Runs as a scope finalizer, so it also unwinds a partial start. */
export const stopOwnedChild = (
	child: BackendChild,
	instance: string,
	timeoutMs = 2000,
): Effect.Effect<void, never, BackendRuntime> =>
	Effect.gen(function* () {
		const runtime = yield* BackendRuntime;
		// Both waits are bounded: a child that ignores SIGTERM and then SIGKILL
		// must not be able to stall teardown forever.
		const exitWithin = (ms: number) =>
			Effect.promise(() =>
				Promise.race([
					child.exited.then(() => true),
					new Promise<boolean>((resolve) =>
						setTimeout(() => resolve(false), ms),
					),
				]),
			);
		if (child.isRunning()) {
			child.kill("SIGTERM");
			const exited = yield* exitWithin(timeoutMs);
			if (!exited && child.isRunning()) {
				child.kill("SIGKILL");
				yield* exitWithin(timeoutMs);
			}
		}
		yield* runtime.removeExtractionDir(instance);
	}).pipe(Effect.catchAll(() => Effect.void));

/**
 * Acquire the owned backend. Scoped: the child and its extraction directory are
 * released on scope close, on failure and on interruption alike, so quitting
 * during any acquisition step stops exactly the resources already acquired.
 */
export const acquireOwnedBackend = (
	options: StartBackendOptions,
): Effect.Effect<
	OwnedBackend,
	BackendStartupError,
	BackendRuntime | Scope.Scope
> =>
	Effect.gen(function* () {
		const runtime = yield* BackendRuntime;
		const instance = options.instance ?? newInstanceId();
		const token = options.token ?? newInstanceToken();
		const url = backendUrl(options.port);
		const expected = expectedIdentity(instance);

		// A listener that is not the child we are about to spawn is somebody
		// else's process: report it and let the operator attach explicitly.
		const existing = yield* runtime.probe(url);
		if (existing && !healthMatches(existing, expected)) {
			return yield* Effect.fail(
				new BackendStartupError({
					reason: "port-conflict",
					detail: `Port ${options.port} is already served by another environment backend (instance ${
						existing.instance ?? "unknown"
					}, config ${
						existing.configDir ?? "unknown"
					}). Stop that server, or attach to it with \`agentic-coding attach http://127.0.0.1:${options.port}\` / \`--devenv-url http://127.0.0.1:${options.port}\`.`,
				}),
			);
		}

		const binary = yield* runtime.resolveBinary(instance);
		const child = yield* Effect.acquireRelease(
			runtime.spawnBackend({
				port: options.port,
				instance,
				binary,
				homeDir: expected.homeDir,
				token,
			}),
			(child) => stopOwnedChild(child, instance, options.stopTimeoutMs ?? 2000),
		);

		// Readiness needs the spawned identity, never merely an open port.
		const retries = options.readinessRetries ?? 10;
		let ready = false;
		for (let attempt = 0; attempt < retries && !ready; attempt++) {
			const health = yield* runtime.probe(url);
			if (health && healthMatches(health, expected)) {
				ready = true;
				break;
			}
			yield* Effect.sleep(`${READY_POLL_MS} millis`);
		}
		if (!ready) {
			const health = yield* runtime.probe(url);
			return yield* Effect.fail(
				health
					? new BackendStartupError({
							reason: "identity-mismatch",
							detail: `Backend on port ${options.port} answered health without the spawned instance identity (expected ${instance}, got ${
								health.instance ?? "none"
							})`,
						})
					: new BackendStartupError({
							reason: "not-ready",
							detail: `Environment backend did not become ready on port ${options.port}`,
						}),
			);
		}

		return {
			port: options.port,
			url,
			instance,
			pid: child.pid,
			token,
		} satisfies OwnedBackend;
	});
