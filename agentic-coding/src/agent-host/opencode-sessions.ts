// OpenCode session bridge for the orchestrator's `opencode_session` tool.
//
// The shell runs one `opencode` TUI client against OpenCode's default
// background service. The orchestrator uses the same service through
// `opencode api` in the same project directory: it creates a session there and
// admits the first prompt, then may admit follow-ups by session id. Prompt
// admission is asynchronous — the command returns the enqueued user message,
// not OpenCode's answer — so the tool never blocks on a coding turn.
/** The enqueued user message returned when a prompt is admitted. */
export interface OpenCodeSessionAdmission {
	readonly messageId: string;
	readonly sessionId: string;
}

const API_TIMEOUT_MS = 60_000;

export interface OpenCodeApiInput {
	readonly cwd: string;
	readonly operation: string;
	readonly body?: unknown;
	readonly params?: Readonly<Record<string, string>>;
}

/** The argv for one `opencode api` call (exported for a unit test). */
export function openCodeApiArgs(input: OpenCodeApiInput): string[] {
	const args = ["opencode", "api", input.operation];
	for (const [key, value] of Object.entries(input.params ?? {}))
		args.push("--param", `${key}=${value}`);
	if (input.body !== undefined) args.push("-d", JSON.stringify(input.body));
	return args;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorMessage(value: unknown): string | undefined {
	const body = record(value);
	if (!body) return undefined;
	const message = typeof body.message === "string" ? body.message : undefined;
	const tag = typeof body._tag === "string" ? body._tag : undefined;
	if (message && tag) return `${tag}: ${message}`;
	return message ?? tag;
}

function truncate(value: string): string {
	return value.length <= 300 ? value : `${value.slice(0, 297)}…`;
}

/**
 * Turn one `opencode api` result into its `data` payload, or throw a useful
 * message. The CLI prints an error envelope to stdout and `HTTP <code>` to
 * stderr while exiting nonzero, so neither stream alone is enough.
 */
export function parseOpenCodeApiOutput(
	stdout: string,
	stderr: string,
	exitCode: number,
): unknown {
	const trimmed = stdout.trim();
	let parsed: unknown;
	if (trimmed) {
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = undefined;
		}
	}
	const body = record(parsed);
	if (exitCode !== 0 || body?._tag) {
		const stderrText = stderr.trim();
		const reason =
			errorMessage(body) ??
			(stderrText || undefined) ??
			(trimmed
				? truncate(trimmed)
				: `opencode api exited with code ${exitCode}`);
		throw new Error(reason);
	}
	if (!trimmed) {
		throw new Error(stderr.trim() || "opencode api returned no output");
	}
	if (!body) {
		throw new Error(
			`opencode api returned non-JSON output: ${truncate(trimmed)}`,
		);
	}
	if (!("data" in body))
		throw new Error("opencode api response did not contain data");
	return body.data;
}

/** Run one API operation against the project's default background service. */
async function openCodeApi(input: OpenCodeApiInput): Promise<unknown> {
	const proc = Bun.spawn(openCodeApiArgs(input), {
		cwd: input.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill("SIGTERM");
		} catch {}
	}, API_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (timedOut)
			throw new Error(
				`opencode api ${input.operation} timed out after ${API_TIMEOUT_MS / 1000}s`,
			);
		return parseOpenCodeApiOutput(stdout, stderr, code);
	} finally {
		clearTimeout(timer);
	}
}

function admission(value: unknown): OpenCodeSessionAdmission {
	const body = record(value);
	if (
		!body ||
		typeof body.id !== "string" ||
		typeof body.sessionID !== "string"
	)
		throw new Error("OpenCode did not return the admitted user message");
	return {
		messageId: body.id,
		sessionId: body.sessionID,
	};
}

export interface OpenCodeSessionResult {
	readonly sessionId: string;
	readonly title?: string;
	readonly admitted: OpenCodeSessionAdmission;
}

/** Create a session in `cwd` and admit its initial prompt. */
export async function createOpenCodeSession(input: {
	readonly cwd: string;
	readonly prompt: string;
	readonly title?: string;
}): Promise<OpenCodeSessionResult> {
	const created = record(
		await openCodeApi({
			cwd: input.cwd,
			operation: "session.create",
			body: {
				...(input.title ? { title: input.title } : {}),
				location: { directory: input.cwd },
			},
		}),
	);
	const sessionId = typeof created?.id === "string" ? created.id : undefined;
	if (!sessionId) throw new Error("OpenCode created no session id");
	let user: unknown;
	try {
		user = await openCodeApi({
			cwd: input.cwd,
			operation: "session.prompt",
			params: { sessionID: sessionId },
			body: { text: input.prompt },
		});
	} catch (error) {
		throw new Error(
			`created OpenCode session ${sessionId}, but failed to admit its initial prompt: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		sessionId,
		...(typeof created?.title === "string" ? { title: created.title } : {}),
		admitted: admission(user),
	};
}

/** Admit a follow-up prompt to an existing session. */
export async function promptOpenCodeSession(input: {
	readonly cwd: string;
	readonly sessionId: string;
	readonly prompt: string;
}): Promise<{ sessionId: string; admitted: OpenCodeSessionAdmission }> {
	const user = await openCodeApi({
		cwd: input.cwd,
		operation: "session.prompt",
		params: { sessionID: input.sessionId },
		body: { text: input.prompt },
	});
	return { sessionId: input.sessionId, admitted: admission(user) };
}
