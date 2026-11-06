import type { Plan } from "./model.ts";
import { type Exit, type processEnvironment, ShellProcess } from "./shell.ts";

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
		private environment?: ReturnType<typeof processEnvironment>,
	) {}
	get logs() {
		return `${this.output}${this.current?.logs ?? ""}`.slice(-64000);
	}
	private note(message: string) {
		// Fixed diagnostic text only: never argv, private output, paths or secrets.
		this.output = `${this.output}\n${message}\n`.slice(-64000);
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
				environment: this.environment,
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
			if (options.effect && exit.signal) {
				this.uncertainEffect = true;
				this.note(
					"Mutating environment CLI exited by signal; remote effects remain uncertain even if later cleanup observes absence.",
				);
			}
			if (child.cleanupFailed)
				throw new Error("CLI process cleanup is uncertain");
			if (oversize)
				throw new Error("Environment CLI response exceeded its bound");
			return { exit, stdout };
		} catch {
			// An interrupted mutating client is not proof of remote cancellation.
			if (options.effect) this.uncertainEffect = true;
			this.note(
				options.effect
					? "Mutating environment CLI failed or was interrupted; remote effects remain uncertain even if later cleanup observes absence."
					: "Non-mutating environment CLI failed or was interrupted; this does not confirm resource absence.",
			);
			throw new Error(
				"Environment CLI command failed or was interrupted; inspect redacted logs",
			);
		} finally {
			try {
				await child.stop();
			} catch {
				this.cleanupFailed = true;
				this.note(
					"Environment CLI local stop did not settle; the resource remains quarantined.",
				);
			}
			if (child.cleanupFailed) {
				this.cleanupFailed = true;
				this.note(
					"Environment CLI local process-group cleanup could not be confirmed; the resource remains quarantined.",
				);
			}
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
			this.note(
				options.effect
					? "Mutating environment CLI returned failure; remote effects remain uncertain even if later cleanup observes absence."
					: "Non-mutating environment CLI returned failure; this does not confirm resource absence.",
			);
			throw new Error(
				"Environment CLI returned failure; inspect redacted logs",
			);
		}
		return result.stdout;
	}
}
