// Private Git operation adapter (`port-git-providers-and-ai-to-bun`, task 1.3,
// wired for Go callers in task 2.5).
//
// While the Go action owner still executes actions, a `git` command step is
// forwarded here instead of being run by the Go process, so the Git capability
// has exactly one implementation. The envelope carries:
//   • the exact run/step/command identity the Go run tree records, echoed back
//     so the Go owner can record one command exactly once;
//   • one argv invocation — never a shell string, so no user data is
//     interpolated into a command line;
//   • the cancellation signal of the originating request, forwarded to the
//     child process.
// Credentials never cross the wire: the directory names the checkout and Bun
// resolves any provider credential itself.
//
// The adapter performs no outbound request, so it can never recurse back into
// the delegated Go child. `port-action-execution-to-bun` task 4.3 removes it
// once the Bun action owner calls the Git service directly.
import { Schema } from "effect";
import { decodeRequest, MAX_PATH_CHARS } from "../protocol.ts";
import { GitError, type GitRepository } from "./git-repository.ts";

/** Private operation endpoint, distinct from the delegated legacy surface. */
export const PRIVATE_GIT_COMMAND_PATH =
	"/api/v1/integrations/private/git-command";

/** Bounded argv: enough for any compiled Git step, small enough to reject a
 * caller that tries to ship a script. */
export const MAX_GIT_ARGS = 64;
/** Bounded captured output per stream. */
export const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Bounded wall clock for one forwarded command. */
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export class IntegrationOperationError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status: number, message: string) {
		super(message);
		this.name = "IntegrationOperationError";
		this.code = code;
		this.status = status;
	}
}

const boundedText = Schema.String.pipe(Schema.maxLength(MAX_PATH_CHARS));
/** An argv entry: no NUL, no newline — a control character in argv is a caller
 * bug, not a legitimate Git argument. */
const argvEntry = Schema.String.pipe(
	Schema.maxLength(MAX_PATH_CHARS),
	Schema.pattern(/^[^\0\r\n]*$/),
);

export const gitCommandRequestSchema = Schema.Struct({
	operation: Schema.Literal("git.command"),
	/** Action run identity, echoed back with the result. */
	runId: boundedText,
	stepId: boundedText,
	commandId: boundedText,
	/** Checkout the argv runs in. */
	directory: boundedText,
	args: Schema.Array(argvEntry).pipe(Schema.maxItems(MAX_GIT_ARGS)),
	/** Repository URL, so Bun can resolve a provider credential for the fetch
	 * or push it forwards. Empty means "no credential lookup". */
	repositoryUrl: Schema.optional(boundedText),
});

export type GitCommandRequest = Schema.Schema.Type<
	typeof gitCommandRequestSchema
>;

export interface GitCommandOutcome {
	readonly runId: string;
	readonly stepId: string;
	readonly commandId: string;
	/** The executed argv with credential config redacted. */
	readonly command: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly cancelled: boolean;
	readonly truncated: boolean;
}

export interface GitCommandServices {
	readonly git: GitRepository;
	/** Bounded command timeout override (tests). */
	readonly timeoutMs?: number;
}

/** Decode one bounded private operation. Excess or unknown fields fail here
 * rather than reaching an operation. */
export function decodeGitCommandRequest(body: unknown): GitCommandRequest {
	return decodeRequest(
		"integrations.git.command",
		gitCommandRequestSchema,
		body,
	);
}

/**
 * Execute one forwarded Git invocation. Cancellation of the originating
 * request kills the child and reports `cancelled` instead of an exit code, so
 * the Go owner can record the command as cancelled rather than failed.
 */
export async function executeGitCommand(
	services: GitCommandServices,
	request: GitCommandRequest,
	signal?: AbortSignal,
): Promise<GitCommandOutcome> {
	const config =
		request.repositoryUrl && request.repositoryUrl !== ""
			? services.git.credentialConfig(request.repositoryUrl)
			: [];
	const argv = [
		"git",
		"-C",
		request.directory,
		...config.flatMap((entry) => ["-c", entry]),
		...request.args,
	];
	// A credential header is never part of a recorded command.
	const display = [
		"git",
		"-C",
		request.directory,
		...config.map(redactedConfig),
		...request.args,
	].join(" ");
	const child = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		// No inherited stdin: a Git command that would wait for input must not
		// consume the server's own stream, and an unauthenticated remote must fail
		// with a bounded diagnostic instead of prompting for a passphrase.
		stdin: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const timeoutMs = services.timeoutMs ?? COMMAND_TIMEOUT_MS;
	let cancelled = false;
	let timedOut = false;
	const onAbort = () => {
		cancelled = true;
		child.kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readBounded(child.stdout),
			readBounded(child.stderr),
			child.exited,
		]);
		if (cancelled)
			throw new IntegrationOperationError(
				"git-command-cancelled",
				409,
				`${display} was cancelled`,
			);
		if (timedOut)
			throw new IntegrationOperationError(
				"git-command-timeout",
				504,
				`${display} exceeded ${timeoutMs}ms`,
			);
		return {
			runId: request.runId,
			stepId: request.stepId,
			commandId: request.commandId,
			command: display,
			stdout: stdout.text,
			stderr: stderr.text,
			exitCode: exitCode ?? 1,
			cancelled: false,
			truncated: stdout.truncated || stderr.truncated,
		};
	} catch (error) {
		if (error instanceof IntegrationOperationError) throw error;
		throw new IntegrationOperationError(
			"git-command-failed",
			409,
			error instanceof GitError
				? error.message
				: error instanceof Error
					? error.message.slice(0, 512)
					: String(error),
		);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		clearTimeout(timer);
	}
}

/** `key=<redacted>` for a `-c` value that carries a credential header. */
function redactedConfig(entry: string): string {
	const separator = entry.indexOf("=");
	return separator < 0
		? "<redacted>"
		: `${entry.slice(0, separator)}=<redacted>`;
}

/** Read one pipe up to the bound, reporting whether the bound cut it short. */
async function readBounded(
	stream: ReadableStream<Uint8Array> | undefined,
): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
			chunks.push(value.subarray(0, MAX_COMMAND_OUTPUT_BYTES - total));
			total = MAX_COMMAND_OUTPUT_BYTES;
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(joined), truncated };
}
