import type { Plan } from "./catalog.ts";
import { type Exit, ShellProcess } from "./shell.ts";

/** Internal argv-only adapter. Machine-readable stdout is bounded in memory and
 * deliberately never copied to logs: inspecting a foreign resource may expose
 * credentials that are not among this task's known secret references. */
export class EnvironmentCommands {
	private current: ShellProcess | null = null;
	private output = "";
	cleanupFailed = false;
	uncertainEffect = false;
	constructor(
		private plan: Plan,
		private configDir: string,
		private executable: string,
		private prefix: string[],
	) {}
	get logs() {
		return `${this.output}${this.current?.logs ?? ""}`.slice(-64000);
	}
	async run(
		args: string[],
		options: {
			signal?: AbortSignal;
			timeoutMs: number;
			machine?: boolean;
			effect?: boolean;
			input?: string;
		},
	): Promise<{ exit: Exit; stdout: string }> {
		options.signal?.throwIfAborted();
		if (this.current)
			throw new Error("Concurrent environment CLI commands are not allowed");
		let stdout = "",
			bytes = 0,
			oversize = false;
		const child = new ShellProcess(
			{ ...this.plan, readyText: null, timeoutMs: options.timeoutMs },
			this.configDir,
			{
				executable: this.executable,
				args: [...this.prefix, ...args],
				privateOutput: options.machine,
				input: options.input,
				captureStdout: (chunk) => {
					if (!options.machine) return;
					bytes += Buffer.byteLength(chunk);
					if (bytes > 1048576) {
						oversize = true;
						return;
					}
					if (!oversize) stdout += chunk;
				},
			},
		);
		this.current = child;
		try {
			const exit = await child.wait(options.signal);
			if (options.effect && exit.signal) this.uncertainEffect = true;
			if (child.cleanupFailed)
				throw new Error("CLI process cleanup is uncertain");
			if (oversize)
				throw new Error("Environment CLI response exceeded its bound");
			return { exit, stdout };
		} catch {
			// An interrupted mutating client is not proof of remote cancellation.
			if (options.effect) this.uncertainEffect = true;
			throw new Error(
				"Environment CLI command failed or was interrupted; inspect redacted logs",
			);
		} finally {
			try {
				await child.stop();
			} catch {
				this.cleanupFailed = true;
			}
			if (child.cleanupFailed) this.cleanupFailed = true;
			this.output = `${this.output}${child.logs}`.slice(-64000);
			this.current = null;
		}
	}
	async checked(
		args: string[],
		options: {
			signal?: AbortSignal;
			timeoutMs: number;
			machine?: boolean;
			effect?: boolean;
			input?: string;
		},
	) {
		const result = await this.run(args, options);
		if (result.exit.code !== 0 || result.exit.signal) {
			if (options.effect) this.uncertainEffect = true;
			throw new Error(
				"Environment CLI returned failure; inspect redacted logs",
			);
		}
		return result.stdout;
	}
}
