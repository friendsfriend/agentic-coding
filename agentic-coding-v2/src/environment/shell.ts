import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { contained } from "../git.ts";
import { authentication } from "./http-options.ts";
import type { Plan } from "./model.ts";
import type { Exit, LogTiming } from "./process.ts";
import { shellReady } from "./shell-readiness.ts";

/** One leading Docker/Podman log timestamp; anything else is not guessed. */
function runtimeTimestamp(line: string) {
	const match =
		/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) (.*)$/.exec(
			line,
		);
	if (!match) return undefined;
	return { line: match[2] ?? "", at: match[1] };
}

import type { TelemetryCollector } from "./telemetry.ts";

export type { Exit } from "./process.ts";
export function processEnvironment(configDir: string, plan: Plan) {
	const file = path.join(configDir, ".env");
	const secrets = fs.existsSync(file)
		? parseEnv(fs.readFileSync(file, "utf8"))
		: {};
	const resolved = Object.fromEntries(
		Object.entries(plan.secretRefs).map(([key, ref]) => {
			const value = secrets[ref] ?? process.env[ref];
			if (!value)
				throw new Error(`Missing environment secret reference: ${ref}`);
			if (value.includes("\0"))
				throw new Error(`Invalid environment secret reference: ${ref}`);
			return [key, value];
		}),
	);
	const auth = Object.fromEntries(
		Object.entries(plan.endpointAuthRefs ?? {}).map(([endpoint, ref]) => [
			endpoint,
			authentication(ref, resolved),
		]),
	);
	const connection = plan.queryConnection,
		queryCredentials = connection
			? Object.freeze({
					username: resolved[connection.usernameRef] ?? "",
					password: resolved[connection.passwordRef] ?? "",
				})
			: undefined;
	if (
		queryCredentials &&
		(!queryCredentials.username || !queryCredentials.password)
	)
		throw new Error(
			"Query credentials are unavailable from the declared startup references",
		);
	const hidden = [
		...new Set(
			[
				...Object.values(resolved),
				...Object.values(auth).flatMap((value) => [
					value,
					value.replace(/^(Basic|Bearer) /, ""),
				]),
			]
				.flatMap((value) => [value, ...value.split(/\r?\n/)])
				.filter(Boolean),
		),
	].sort((a, b) => b.length - a.length);
	return {
		redactionValues: Object.freeze(hidden),
		queryCredentials: () => queryCredentials,
		authorization: (endpoint: string) =>
			Object.hasOwn(auth, endpoint) ? auth[endpoint] : undefined,
		env: {
			...Object.fromEntries(
				["PATH", "HOME", "LANG", "TMPDIR", "TERM"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			),
			...plan.environment,
			...resolved,
			WORKSPACE: plan.workspace,
			CONFIG_DIR: configDir,
		},
		redact: (value: string) =>
			hidden.reduce(
				(result, secret) => result.replaceAll(secret, "[REDACTED]"),
				value,
			),
	};
}

/** A live handle, never reconstructed from a persisted PID. POSIX process groups
 * bound normal child cleanup; this is deliberately not an OS sandbox. */
export class ShellProcess {
	private child: ChildProcess;
	private stopping: Promise<void> | null = null;
	private ended = false;
	private mainExited = false;
	private output = "";
	private timedEntries: LogTiming["entries"] = [];
	private timedCharacters = 0;
	private timingTruncated = false;
	private providerTimed = false;
	private readyObserved = false;
	private exit: Exit | null = null;
	private cleanupUncertain = false;
	readonly done: Promise<Exit>;
	readonly redact: (value: string) => string;
	readonly authorization: (endpoint: string) => string | undefined;
	readonly queryCredentials: () =>
		| Readonly<{ username: string; password: string }>
		| undefined;
	readonly spawned: Promise<boolean>;
	readonly telemetry?: TelemetryCollector;
	constructor(
		readonly plan: Plan,
		configDir: string,
		invocation?: {
			executable: string;
			args: string[];
			captureStdout?: (chunk: string) => void;
			/** The runtime prefixes each line with its own timestamp; strip it and
			 * keep that event time instead of substituting host receipt time. */
			runtimeTimestamps?: boolean;
			privateOutput?: boolean;
			input?: string;
			/** Internal live-handle startup snapshot; never a tool/config input. */
			environment?: ReturnType<typeof processEnvironment>;
		},
		capture?: {
			collector: TelemetryCollector;
			environment: ReturnType<typeof processEnvironment>;
		},
	) {
		if (process.platform === "win32")
			throw new Error("Shell environment runtime currently requires POSIX");
		if (
			Boolean(plan.telemetry) !== Boolean(capture) &&
			(!invocation || plan.runtime === "shell")
		)
			throw new Error(
				"Native telemetry requires the exact live approved startup scope",
			);
		const frozen =
			capture?.environment ??
			invocation?.environment ??
			processEnvironment(configDir, plan);
		const { authorization, queryCredentials } = frozen;
		const env = { ...frozen.env, ...capture?.collector.environment };
		const redact = capture?.collector.redact ?? frozen.redact;
		this.telemetry = capture?.collector;
		this.queryCredentials = queryCredentials;
		this.redact = redact;
		this.providerTimed = invocation?.runtimeTimestamps === true;
		this.authorization = authorization;
		const cwd = contained(
			plan.workspace,
			path.relative(plan.workspace, plan.cwd),
		);
		if (!fs.statSync(cwd).isDirectory())
			throw new Error("Environment cwd is no longer a workspace directory");
		try {
			this.child = spawn(
				invocation?.executable ?? "/bin/sh",
				invocation?.args ?? ["-c", plan.command],
				{
					cwd,
					env,
					detached: true,
					stdio: [
						invocation?.input === undefined ? "ignore" : "pipe",
						"pipe",
						"pipe",
					],
				},
			);
		} catch {
			throw new Error(
				"Environment process could not start with the configured plan",
			);
		}
		if (invocation?.input !== undefined) {
			this.child.stdin?.on("error", () => {
				/* Early client exit is reported by its exit status. */
			});
			this.child.stdin?.end(invocation.input);
		}
		const append = (line: string, observedAt?: string) => {
			const text = `${redact(line)}\n`;
			this.output = `${this.output}${text}`.slice(-64000);
			this.timedEntries.push({
				receivedAt: Date.now(),
				characters: text.length,
				...(observedAt ? { observedAt } : {}),
			});
			this.timedCharacters += text.length;
			while (this.timedCharacters > 64000 || this.timedEntries.length > 2048) {
				const removed = this.timedEntries.shift();
				if (!removed) break;
				this.timedCharacters -= removed.characters;
				this.timingTruncated = true;
			}
		};
		const flushers: (() => void)[] = [];
		for (const stream of [this.child.stdout, this.child.stderr]) {
			if (!stream) continue;
			let pending = "",
				readinessTail = "",
				dropping = false;
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				if (stream === this.child.stdout) invocation?.captureStdout?.(chunk);
				if (invocation?.privateOutput) return;
				// Observe the bounded raw stream, not redacted/line-buffered presentation.
				// A service may emit its marker without a newline; redaction must not invent one.
				if (this.plan.readyText && !this.readyObserved) {
					const text = readinessTail + chunk;
					this.readyObserved = text.includes(this.plan.readyText);
					const keep = this.plan.readyText.length - 1;
					readinessTail = keep ? text.slice(-keep) : "";
				}
				const lines = `${pending}${chunk}`.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const stamped = invocation?.runtimeTimestamps
						? runtimeTimestamp(line)
						: undefined;
					if (!dropping)
						append(
							(stamped?.line ?? line).length > 8192
								? "[oversize log line omitted]"
								: (stamped?.line ?? line),
							stamped?.at,
						);
					dropping = false;
				}
				if (pending.length > 8192) {
					if (!dropping) append("[oversize log line omitted]");
					pending = "";
					dropping = true;
				}
			});
			flushers.push(() => {
				if (pending && !dropping) append(pending);
			});
		}
		this.spawned = new Promise((resolve) => {
			this.child.once("spawn", () => resolve(true));
			this.child.once("error", () => resolve(false));
		});
		this.done = new Promise((resolve) => {
			this.child.once("error", (error) => append(redact(error.message)));
			// The main process may exit leaving children. Stop this live process group's
			// remaining descendants before releasing the application slot.
			this.child.once("exit", () => {
				this.mainExited = true;
				void this.closeTelemetry();
				this.signal("SIGKILL");
			});
			this.child.once("close", async (code, signal) => {
				for (const flush of flushers) flush();
				await this.confirmGroupExit();
				await this.closeTelemetry();
				this.ended = true;
				this.exit = { code, signal };
				resolve(this.exit);
			});
		});
	}
	get pid() {
		return this.child.pid ?? null;
	}
	get logs() {
		return this.output;
	}
	get logTiming(): LogTiming {
		return {
			basis: this.providerTimed
				? "provider-event-time-completed-lines"
				: "host-receipt-completed-lines",
			entries: this.timedEntries.map((entry) => ({ ...entry })),
			truncated: this.timingTruncated,
		};
	}
	get closing() {
		return this.stopping !== null;
	}
	get outcome() {
		return this.exit;
	}
	get cleanupFailed() {
		return this.cleanupUncertain;
	}
	private async closeTelemetry() {
		try {
			await this.telemetry?.close();
		} catch {
			this.cleanupUncertain = true;
		}
	}
	private signal(signal: NodeJS.Signals): boolean {
		if (!this.child.pid) return true;
		try {
			process.kill(-this.child.pid, signal);
			return true;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ESRCH"
			)
				return true;
			this.cleanupUncertain = true;
			return false;
		}
	}
	private async confirmGroupExit() {
		if (!this.child.pid) return;
		const deadline = Date.now() + 1000;
		for (;;) {
			try {
				process.kill(-this.child.pid, 0);
			} catch (error) {
				if (
					!(
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "ESRCH"
					)
				)
					this.cleanupUncertain = true;
				return;
			}
			if (Date.now() >= deadline) {
				this.cleanupUncertain = true;
				return;
			}
			await Bun.sleep(10);
		}
	}
	async ready(signal?: AbortSignal) {
		if (!(await this.spawned))
			throw new Error("Environment process could not start");
		const deadline = Date.now() + this.plan.timeoutMs;
		while ((this.plan.readyText && !this.readyObserved) || this.plan.readyUrl) {
			signal?.throwIfAborted();
			if (this.mainExited || this.ended)
				throw new Error("Environment process exited during startup");
			if (Date.now() >= deadline)
				throw new Error("Environment startup timed out");
			if (this.plan.readyUrl && (await shellReady(this.plan.readyUrl, signal)))
				break;
			await Bun.sleep(this.plan.readyUrl ? 50 : 10);
		}
		signal?.throwIfAborted();
		if (this.mainExited || this.ended)
			throw new Error("Environment process exited during startup");
	}
	async wait(signal?: AbortSignal): Promise<Exit> {
		const deadline = Date.now() + this.plan.timeoutMs;
		while (!this.ended) {
			signal?.throwIfAborted();
			if (Date.now() >= deadline)
				throw new Error("Environment action timed out");
			await Bun.sleep(10);
		}
		return this.done;
	}
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			await this.closeTelemetry();
			if (this.ended) return;
			if (!this.signal("SIGTERM"))
				throw new Error(
					"Process group cleanup could not be authorized by the OS",
				);
			const escalation = setTimeout(() => this.signal("SIGKILL"), 1000);
			let deadline: ReturnType<typeof setTimeout> | null = null;
			const uncertain = new Promise<never>((_, reject) => {
				deadline = setTimeout(() => {
					this.cleanupUncertain = true;
					reject(
						new Error(
							"Process group cleanup did not settle; inspection required",
						),
					);
				}, 2000);
				deadline.unref();
			});
			escalation.unref();
			try {
				await Promise.race([this.done, uncertain]);
			} finally {
				clearTimeout(escalation);
				if (deadline) clearTimeout(deadline);
			}
		})();
		return this.stopping;
	}
}
