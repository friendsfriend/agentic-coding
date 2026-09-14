// Change-request AI review: the temporary checkout, the Pi RPC stream and the
// scoped comment callback (`port-git-providers-and-ai-to-bun`,
// tasks 4.3-4.5), ported from `server/pkg/server/handlers_cr_ai.go`.
//
// Ownership and bounds preserved:
//   - the review checkout is a uniquely named directory in the system temp
//     directory, and only that directory is removed; a pre-existing worktree is
//     never touched,
//   - the prompt file lives inside the owned checkout and is removed with it,
//   - a callback token is 16 random bytes, is registered only for a real change
//     request, and is revoked when the stream ends — so a disconnect makes the
//     token unknown rather than reusable,
//   - the callback is scoped to the session's app and change request; it cannot
//     post to another review,
//   - the review runs under a 5 minute bound and a cancelled stream kills the
//     child process.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logAnalysisEventStream } from "./ai-streams.ts";
import type { GitLabChangeRequests } from "./gitlab-changerequest.ts";
import type { GitLabProjectInfo } from "./gitlab-client.ts";

export const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
export const REVIEW_PROMPT_FILE = "REVIEW_PROMPT.md";

/** What a review session needs to post a comment on its own change request. */
export interface ReviewTarget {
	readonly changeRequests: GitLabChangeRequests;
	readonly project: GitLabProjectInfo;
}

export interface ReviewSession {
	readonly appIdent: string;
	readonly crIid: number;
	versions?: { baseSha: string; headSha: string; startSha: string };
}

/** The per-review callback registry. A token is only valid while its stream
 * runs; `deregister` on stream close is what revokes it. */
export class CrReviewSessions {
	private readonly sessions = new Map<string, ReviewSession>();

	register(token: string, appIdent: string, crIid: number): void {
		this.sessions.set(token, { appIdent, crIid });
	}

	deregister(token: string): void {
		this.sessions.delete(token);
	}

	get(token: string): ReviewSession | undefined {
		return this.sessions.get(token);
	}

	get size(): number {
		return this.sessions.size;
	}
}

export function generateReviewToken(): string {
	return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Owned checkout
// ---------------------------------------------------------------------------

/** A review checkout that this stream created and therefore owns. */
export interface OwnedReviewCheckout {
	readonly path: string;
	readonly repoDir: string;
}

/**
 * Create the review checkout for `branch`. The fetch is best-effort and
 * bounded; a detached checkout at `origin/<branch>` is preferred, with a local
 * branch as fallback — the same order the Go helper used.
 */
export function crWorktreeAdd(
	repoDir: string,
	branch: string,
	worktreePath: string,
): { ok: true } | { ok: false; error: string } {
	const fetch = Bun.spawnSync(
		["git", "-C", repoDir, "fetch", "origin", branch],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			timeout: FETCH_TIMEOUT_MS,
		},
	);
	void fetch;
	const detached = Bun.spawnSync(
		[
			"git",
			"-C",
			repoDir,
			"worktree",
			"add",
			"--detach",
			worktreePath,
			`origin/${branch}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (detached.exitCode === 0) return { ok: true };
	const local = Bun.spawnSync(
		["git", "-C", repoDir, "worktree", "add", worktreePath, branch],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (local.exitCode !== 0)
		return { ok: false, error: local.stderr.toString().trim() };
	return { ok: true };
}

/** Remove an owned checkout. Returns an error string instead of throwing so a
 * cleanup failure is logged without masking the review result. */
export function crWorktreeRemove(
	repoDir: string,
	worktreePath: string,
): string | undefined {
	const result = Bun.spawnSync(
		["git", "-C", repoDir, "worktree", "remove", "--force", worktreePath],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0)
		return result.stderr.toString().trim() || `exit ${result.exitCode}`;
	return undefined;
}

/** `os.tmpdir()/cr-review-<nanoseconds>`, unique per review. */
export function reviewCheckoutPath(now = process.hrtime.bigint()): string {
	return path.join(os.tmpdir(), `cr-review-${now}`);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Append the inline-comment instructions. A non-GitLab review gets none. */
export function buildCallbackInstructions(
	callbackUrl: string,
	isChangeRequest: boolean,
): string {
	if (!isChangeRequest) return "";
	return `

---
INLINE COMMENT TOOL:
As you identify specific code issues, post them as inline GitLab comments using curl.
This creates real comments directly on the diff lines in the CR.

For a line-specific comment (preferred when you have a precise file + line):
  curl -s -X POST '${callbackUrl}' \\
    -H 'Content-Type: application/json' \\
    -d '{"file":"<new_path>","line":<new_line_number>,"comment":"<your comment text>"}'

For a general comment not tied to a specific line:
  curl -s -X POST '${callbackUrl}' \\
    -H 'Content-Type: application/json' \\
    -d '{"comment":"<your comment text>"}'

Rules:
- "file" is the path as it appears in the diff (new_path after the change)
- "line" is the new file line number (from the file content, not the diff +/- counter)
- The endpoint returns {"ok":true} on success or {"ok":false,"error":"..."} on failure
- If a line number is wrong and GitLab rejects it, skip that inline comment and note it in your summary instead
- Post inline comments as you find issues, then write a concise overall summary to stdout at the end
- Keep your stdout clean — it is shown to the developer in a review overlay`;
}

// ---------------------------------------------------------------------------
// Pi RPC event mapping
// ---------------------------------------------------------------------------

export type PiRpcEvent =
	| { readonly kind: "delta"; readonly text: string }
	| { readonly kind: "done" }
	| { readonly kind: "ignore" };

/** Map one JSONL event from `pi --mode rpc` onto a stream delta. */
export function mapPiRpcEvent(line: string): PiRpcEvent {
	let event: {
		type?: unknown;
		assistantMessageEvent?: { type?: unknown; delta?: unknown };
		toolName?: unknown;
		args?: unknown;
	};
	try {
		event = JSON.parse(line);
	} catch {
		return { kind: "ignore" };
	}
	switch (event.type) {
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (!inner) return { kind: "ignore" };
			if (inner.type !== "text_delta" && inner.type !== "thinking_delta")
				return { kind: "ignore" };
			const delta = typeof inner.delta === "string" ? inner.delta : "";
			return delta === "" ? { kind: "ignore" } : { kind: "delta", text: delta };
		}
		case "tool_execution_start": {
			const tool = typeof event.toolName === "string" ? event.toolName : "";
			let command = "";
			if (typeof event.args === "object" && event.args !== null) {
				const raw = (event.args as { command?: unknown }).command;
				if (typeof raw === "string") command = raw;
			}
			if (tool === "bash" && command !== "")
				return { kind: "delta", text: `\n> \`${command}\`\n` };
			return { kind: "delta", text: `\n> running ${tool}…\n` };
		}
		case "agent_end":
			return { kind: "done" };
		default:
			return { kind: "ignore" };
	}
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export interface ReviewStreamRequest {
	readonly appIdent: string;
	readonly crIid: number;
	readonly sourceBranch: string;
	readonly prompt: string;
	readonly repoDir: string;
	readonly callbackUrl: string;
}

/**
 * Spawn `pi --mode rpc` in the owned checkout, forward the prompt and stream
 * mapped events as server-sent events. Cleanup of the checkout and the prompt
 * file runs exactly once, for this stream's own path.
 */
export function reviewEventStream(
	request: ReviewStreamRequest,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly hasPi?: boolean;
		readonly timeoutMs?: number;
		readonly onClose?: () => void;
	} = {},
): Response {
	return logAnalysisEventStream(
		streamReviewEvents(request, options),
		options.onClose,
	);
}

async function* streamReviewEvents(
	request: ReviewStreamRequest,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly hasPi?: boolean;
		readonly timeoutMs?: number;
	},
): AsyncGenerator<{ delta?: string; error?: string; done?: boolean }> {
	if (!(options.hasPi ?? true)) {
		yield { error: "pi not found in PATH" };
		return;
	}
	const promptFile = path.join(request.repoDir, REVIEW_PROMPT_FILE);
	try {
		fs.writeFileSync(promptFile, request.prompt, { mode: 0o644 });
	} catch (error) {
		yield {
			error: `failed to write prompt file: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
		return;
	}
	let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		child = Bun.spawn(
			[
				"pi",
				"--mode",
				"rpc",
				"--no-session",
				"--tools",
				"bash,read,grep,find",
				"--thinking",
				"low",
			],
			{
				cwd: request.repoDir,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "pipe",
				env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
			},
		);
	} catch (error) {
		fs.rmSync(promptFile, { force: true });
		yield {
			error: `failed to start pi: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
		return;
	}

	let timedOut = false;
	const timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	try {
		const stdin = child.stdin;
		if (!stdin) {
			yield { error: "failed to open pi stdin" };
			return;
		}
		// Consume stderr concurrently so a chatty child cannot block on a full
		// pipe; the value is only awaited once the process is gone.
		const stderrPromise = new Response(child.stderr).text();
		stdin.write(
			`${JSON.stringify({ type: "prompt", message: request.prompt })}\n`,
		);
		stdin.flush();
		const decoder = new TextDecoder();
		let buffer = "";
		let hadOutput = false;
		let done = false;
		const reader = child.stdout.getReader();
		try {
			while (!done) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line === "") continue;
					const event = mapPiRpcEvent(line);
					if (event.kind === "done") {
						done = true;
						break;
					}
					if (event.kind === "delta") {
						hadOutput = true;
						yield { delta: event.text };
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
		stdin.end();
		await child.exited;
		if (timedOut) {
			// The outcome is known, so stderr is not awaited: a grandchild that
			// inherited the pipe must not hold the stream open.
			yield { error: "review timed out after 5 minutes" };
			return;
		}
		const stderr = await boundedText(stderrPromise, 1000);
		if (!hadOutput) {
			const diagnostic = stderr.trim() || "pi produced no output";
			yield { error: `pi error: ${diagnostic}` };
			return;
		}
		yield { done: true };
	} finally {
		clearTimeout(timer);
		try {
			child.kill();
		} catch {
			// The process is already gone.
		}
		fs.rmSync(promptFile, { force: true });
	}
}

// ---------------------------------------------------------------------------
// Comment callback
// ---------------------------------------------------------------------------

export const AI_ATTRIBUTION =
	"> 🤖 *AI Review — auto-generated. Please verify before acting.*\n\n";

export interface CallbackRequest {
	readonly file: string;
	readonly line: number | undefined;
	readonly comment: string;
}

export type CallbackOutcome =
	| { readonly status: 200; readonly body: { ok: true } }
	| { readonly status: 200; readonly body: { ok: false; error: string } }
	| { readonly status: number; readonly envelope: string };

/**
 * Post one review comment. The session scopes the target: the app and change
 * request come from the token, never from the request body.
 */
export async function submitReviewComment(
	session: ReviewSession,
	request: CallbackRequest,
	resolveTarget: (
		appIdent: string,
	) => ReviewTarget | { readonly error: string; readonly status: number },
): Promise<CallbackOutcome> {
	const target = resolveTarget(session.appIdent);
	if ("error" in target)
		return { status: target.status, envelope: target.error };

	let position:
		| {
				baseSha: string;
				headSha: string;
				startSha: string;
				positionType: string;
				newPath: string;
				oldPath: string;
				newLine: number;
		  }
		| undefined;

	if (request.file !== "" && request.line !== undefined) {
		if (!session.versions) {
			let versions: Record<string, unknown>[];
			try {
				versions = await target.changeRequests.getMrVersions(session.crIid);
			} catch (error) {
				return {
					status: 200,
					body: {
						ok: false,
						error: `fetch CR versions: ${
							error instanceof Error ? error.message : String(error)
						}`,
					},
				};
			}
			if (versions.length === 0)
				return {
					status: 200,
					body: { ok: false, error: "no CR versions found" },
				};
			const latest = versions[0];
			const baseSha = text(latest.base_commit_sha);
			const headSha = text(latest.head_commit_sha);
			const startSha = text(latest.start_commit_sha);
			if (baseSha === "" || headSha === "" || startSha === "")
				return {
					status: 200,
					body: {
						ok: false,
						error: `CR version SHAs missing (base="${baseSha}" head="${headSha}" start="${startSha}")`,
					},
				};
			session.versions = { baseSha, headSha, startSha };
		}
		position = {
			baseSha: session.versions.baseSha,
			headSha: session.versions.headSha,
			startSha: session.versions.startSha,
			positionType: "text",
			newPath: request.file,
			oldPath: request.file,
			newLine: request.line,
		};
	}

	try {
		await target.changeRequests.createMrDiffComment(
			session.crIid,
			`${AI_ATTRIBUTION}${request.comment}`,
			position,
		);
	} catch (error) {
		return {
			status: 200,
			body: {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
	return { status: 200, body: { ok: true } };
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Await a diagnostic read with a bound, so an inherited pipe cannot stall a
 * finished review. */
async function boundedText(
	pending: Promise<string>,
	timeoutMs: number,
): Promise<string> {
	return Promise.race([pending, Bun.sleep(timeoutMs).then(() => "")]);
}
