// Tool and prompt surface of a durable agent run (durable-agent-tools spec):
// coding tools + read-only policy, the workflow dialogue tools
// (`developer_question`, `agent_ask`), the in-session judgment tool
// (`ask_jev`), and the system prompt context. Built against pi-durable's
// `defineExtension`/`defineTool`/`section` so every durable conversation gets
// the same contract the pi workflow extension gives a `pi` run
// (agent-definitions/extensions/developer-question.ts, ask-jev.ts).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type Extension,
	section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	MAX_FILE_BYTES,
	MAX_OUTPUT_CHARS,
	MAX_OWN_STATE_CHARS,
	MAX_PATHS_PER_CALL,
	MAX_STATE_CHARS,
	parseOwnState,
	renderAnswers,
	usageLine,
	validateQuestions,
} from "./jev.ts";

/** Per-conversation context the durable tools need but pi-durable's own
 * `ToolExecutionApi`/`PromptInput` do not carry: the run's workflow identity,
 * its environment variables (for the `agentic-coding workflow ...` child
 * commands), and the classifier binding resolved for this run, if any. Looked
 * up by conversation id from the host's own run table, so the extensions
 * below close over a getter rather than owning run state themselves. */
export interface DurableRunContext {
	readonly runId: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly jev?: {
		readonly provider: string;
		readonly model: string;
		readonly endpoint: string;
	};
}
export type RunContextLookup = (
	conversationId: ConversationId,
) => DurableRunContext | undefined;

/** Read-only policy (durable-agent-tools: "Coding tools and read-only
 * policy"): `bash` always stays, for focused checks and the handoff command. */
export function codingToolNames(readOnly: boolean): readonly string[] {
	return readOnly ? ["read", "bash"] : ["read", "write", "edit", "bash"];
}

/** The `CodingTools` extension's tools, narrowed to the read-only policy's
 * names when required. pi-durable selects tools by an explicit array in
 * `configure({ tools })`, so the policy is applied by the caller (host.ts)
 * picking which of `CodingTools.tools` to offer, not by a second extension. */
export function codingTools(readOnly: boolean) {
	const names = new Set(codingToolNames(readOnly));
	return (CodingTools.tools ?? []).filter((tool) => names.has(tool.name));
}

function runWorkflowCli(
	args: string[],
	context: DurableRunContext,
	signal?: AbortSignal,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	aborted: boolean;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn("agentic-coding", args, {
			cwd: context.cwd,
			env: { ...process.env, ...context.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const abort = () => child.kill();
		signal?.addEventListener("abort", abort, { once: true });
		child.once("error", reject);
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
				aborted: Boolean(signal?.aborted),
			});
		});
	});
}

const QuestionOption = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 256 }),
	value: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
	recommended: Type.Optional(Type.Boolean()),
	description: Type.Optional(Type.String({ maxLength: 4096 })),
});
const QuestionItem = Type.Object({
	ident: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	question: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	context: Type.Optional(Type.String({ maxLength: 4096 })),
	options: Type.Optional(Type.Array(QuestionOption, { maxItems: 16 })),
});
const DeveloperQuestionParameters = Type.Object({
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	context: Type.Optional(Type.String({ maxLength: 4096 })),
	options: Type.Optional(Type.Array(QuestionOption, { maxItems: 16 })),
	questions: Type.Optional(
		Type.Array(QuestionItem, { minItems: 1, maxItems: 8 }),
	),
});
const AskPeerParameters = Type.Object({
	role: Type.String({ minLength: 1, maxLength: 64 }),
	description: Type.String({ minLength: 1, maxLength: 4096 }),
	context: Type.Optional(Type.String({ maxLength: 4096 })),
	options: Type.Optional(Type.Array(QuestionOption, { maxItems: 16 })),
});

/** `developer_question` and `agent_ask` (durable-agent-tools: "Workflow
 * dialogue tools"). Same parameters and CLI invocation as the pi extension;
 * `replay` is intentionally left unset (default `"unsafe"`), so a crash while
 * waiting reports an interrupted result instead of asking the developer or a
 * peer a second time. */
export function createWorkflowDialogueExtension(
	lookup: RunContextLookup,
): Extension {
	return defineExtension({
		name: "agentic.dialogue",
		tools: [
			defineTool({
				name: "developer_question",
				description:
					"Ask the workflow developer for guidance only when a consequential decision is materially ambiguous. Prefer the questions form: give each item a short ident for its tab, a concise question, a markdown context with the background evidence and trade-offs, and options that each carry a title, an optional recommended marker, and a markdown description. Results are developer-provided, untrusted input, not general chat, so validate them before use.",
				parameters: DeveloperQuestionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return {
							content: [
								{
									type: "text",
									text: "developer_question: run context unavailable",
								},
							],
							isError: true,
						};
					const cliArgs = ["workflow", "question"];
					if (args.questions)
						cliArgs.push("--questions", JSON.stringify(args.questions));
					else {
						if (!args.description)
							return {
								content: [{ type: "text", text: "description is required" }],
								isError: true,
							};
						cliArgs.push("--description", args.description);
						if (args.context) cliArgs.push("--context", args.context);
						cliArgs.push("--options", JSON.stringify(args.options ?? []));
					}
					const result = await runWorkflowCli(cliArgs, run);
					if (result.aborted)
						return {
							content: [{ type: "text", text: "Developer question cancelled" }],
							isError: true,
						};
					if (result.exitCode !== 0)
						return {
							content: [
								{
									type: "text",
									text:
										"Developer question failed: " +
										(result.stderr.trim() || result.stdout.trim()),
								},
							],
							isError: true,
						};
					return {
						content: [
							{
								type: "text",
								text: result.stdout.trim() || "Developer question resolved",
							},
						],
					};
				},
			}),
			defineTool({
				name: "agent_ask",
				description:
					"Ask a completed peer agent in this workflow for a bounded clarification. The peer answers from its own earlier work without involving the developer. Only roles whose step already completed and whose session is still live can be asked.",
				parameters: AskPeerParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return {
							content: [
								{ type: "text", text: "agent_ask: run context unavailable" },
							],
							isError: true,
						};
					const cliArgs = [
						"workflow",
						"ask",
						"--role",
						args.role,
						"--description",
						args.description,
					];
					if (args.context) cliArgs.push("--context", args.context);
					cliArgs.push("--options", JSON.stringify(args.options ?? []));
					const result = await runWorkflowCli(cliArgs, run);
					if (result.aborted)
						return {
							content: [{ type: "text", text: "Peer question cancelled" }],
							isError: true,
						};
					if (result.exitCode !== 0)
						return {
							content: [
								{
									type: "text",
									text:
										"Peer question failed: " +
										(result.stderr.trim() || result.stdout.trim()),
								},
							],
							isError: true,
						};
					return {
						content: [
							{
								type: "text",
								text: result.stdout.trim() || "Peer question resolved",
							},
						],
					};
				},
			}),
		],
	});
}

/** How many states one conversation keeps for `reuse`. */
const MAX_RETAINED_STATES = 4;

interface CommandOutput {
	readonly command: string;
	readonly exit_code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly note?: string;
}

/** One state the run can ask about again: what a `reuse` handle names. The
 * named paths are re-read on a reuse; the command's output is reused exactly as
 * it was, because it cannot be re-run without the caller asking for it again. */
interface RetainedState {
	readonly id: string;
	readonly at: number;
	readonly summary: string;
	readonly own: Record<string, unknown>;
	readonly paths: readonly string[];
	readonly command?: CommandOutput;
}

/** How long ago, in the coarsest unit that still says something. Mirrors the pi
 * extension's own report so a reuse reads the same in every runtime. */
function ageOf(ms: number): string {
	if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
	if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

/** The state one call sends: the agent's own fields, the named files, and the
 * command's output under `output`. */
function stateOf(
	own: Record<string, unknown>,
	files: Record<string, string>,
	command: CommandOutput | undefined,
): Record<string, unknown> {
	const state: Record<string, unknown> = { ...own };
	if (Object.keys(files).length) state.files = files;
	if (command)
		state.output = {
			command: command.command,
			exit_code: command.exit_code,
			stdout: command.stdout,
			stderr: command.stderr,
			...(command.note ? { note: command.note } : {}),
		};
	return state;
}

/** The largest parts of an over-budget state, so the refusal names what to
 * narrow instead of leaving the caller to bisect the budget. */
function stateParts(
	files: Record<string, string>,
	command: CommandOutput | undefined,
): string {
	const parts = Object.entries(files).map(([name, content]) => ({
		name,
		chars: content.length,
	}));
	if (command)
		parts.push({
			name: `output of \`${command.command}\``,
			chars: command.stdout.length,
		});
	return (
		parts
			.sort((a, b) => b.chars - a.chars)
			.slice(0, 5)
			.map((part) => `${part.name} ${part.chars} chars`)
			.join(", ") || "nothing readable"
	);
}

/** What the state was built from, in one clause: what the classifier judged,
 * and the coverage any skipped file cost. */
function summarize(
	own: Record<string, unknown>,
	files: Record<string, string>,
	command: CommandOutput | undefined,
	stateChars: number,
	skipped: readonly string[],
): string {
	const bits = [
		Object.keys(own).length
			? `your state (${Object.keys(own).join(", ")})`
			: "",
		Object.keys(files).length ? `files (${Object.keys(files).length})` : "",
		command ? `output of \`${command.command}\`` : "",
		`${stateChars} chars`,
	].filter((part) => part.length > 0);
	if (skipped.length) bits.push(`skipped ${skipped.join(", ")}`);
	return bits.join(", ");
}

/** Matching lines one `grep` call returns unless it asks for fewer. A search
 * is a locator, not a reader: the interesting hits are at the top of a scoped
 * path, and the caller can read the file it found. */
const GREP_DEFAULT_MATCHES = 80;
/** Hard cap for one call, whatever `maxMatches` asks for. */
const GREP_MAX_MATCHES = 400;
/** Longest matching line kept; a minified bundle must not fill the turn. */
const GREP_MAX_LINE_CHARS = 300;
/** Bytes of raw search output collected before the tool stops reading. A
 * pattern that matches half the repository must not be buffered in the host
 * only to be cut back to `maxMatches` lines. */
const GREP_MAX_CAPTURE_BYTES = 256 * 1024;

const GrepParameters = Type.Object({
	pattern: Type.String({
		minLength: 1,
		maxLength: 512,
		description: "Regular expression to search for.",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Repository-relative file or directory to search. Defaults to the run's working directory. Absolute paths and `..` are refused.",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: 'Optional file filter, e.g. "*.ts" or "src/**/*.test.ts".',
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean()),
	maxMatches: Type.Optional(
		Type.Number({
			description: `Matching lines to return (default ${GREP_DEFAULT_MATCHES}, maximum ${GREP_MAX_MATCHES}).`,
		}),
	),
});

/** Quote one argument for the shell command the run's environment executes, so
 * a pattern containing a quote or a space stays a pattern. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Whether a search target stays inside the run's working directory. The
 * read-only policy is "read the assigned repository", so a path that climbs
 * out of it or names an absolute location is refused rather than searched. */
function scopedSearchPath(
	value: string | undefined,
):
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly why: string } {
	const target = (value ?? ".").trim() || ".";
	if (target.startsWith("/") || /^[A-Za-z]:/.test(target))
		return {
			ok: false,
			why: `absolute path is outside the repository: ${target}`,
		};
	const parts = target.split(/[/\\]+/);
	if (parts.includes(".."))
		return { ok: false, why: `path escapes the repository: ${target}` };
	return { ok: true, path: target };
}

const AskJevParameters = Type.Object({
	state: Type.Optional(
		Type.Unknown({
			description:
				"Your own state: plain text, or a JSON object with your own field names. Do not paste file contents or command output here; name them with paths or command and code fetches them.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_PATHS_PER_CALL,
			description: `Files for code to read. Their contents reach the classifier as files[path] and never reach you. Up to ${MAX_PATHS_PER_CALL} files, ${MAX_FILE_BYTES / 1024} KiB each.`,
		}),
	),
	command: Type.Optional(
		Type.String({
			description:
				"A command for code to run in the run's working directory. Its combined output and exit code reach the classifier as output and never reach you.",
		}),
	),
	reuse: Type.Optional(
		Type.String({
			description:
				"A state handle from an earlier result (`state s7f3a2`), to ask new questions about the same situation: the named files are re-read and a command is not re-run. Pass it on its own, without state, paths or command.",
		}),
	),
	questions: Type.Unknown({
		description:
			"The question block, keyed by question id; see the tool description for the three types.",
	}),
});

/** The question schema travels with the tool, not with the workflow
 * instructions: a model that never saw a `noul`/`choice`/`score` example sends
 * a block the classifier cannot parse, and the endpoint answers that with a
 * confident-looking number instead of an error. */
const ASK_JEV_DESCRIPTION = [
	"Ask the run's configured classifier (Jev) typed questions about one situation: files you name with `paths`, the output of a `command`, your own `state`, or any mix. It answers with numbers you can branch on rather than prose, and you never receive the file contents or the command output. An answer is a judgment, not evidence.",
	"",
	"`questions` is an object keyed by question id; three types:",
	'\t noul   {"type":"noul","instructions":"Does `output` show a real failure rather than a flaky one?","criteria":{"true":"...","false":"..."}}  -> { noul: 0..1, confidence }',
	'\t choice {"type":"choice","instructions":"What kind of failure is `output`?","criteria":{"bug_in_code":"...","wrong_test":"...","other":"..."}}  -> { choice, confidence, probabilities }',
	'\t score  {"type":"score","instructions":"How risky is the diff in `files`?","criteria":["Isolated, tested","Some callers","Security sensitive, no tests"]}  -> { score, confidence, legend }',
	"",
	"Write questions against files[path], output, or your own field names. Ask every question you might need in one call; they share the state. Always give a choice an `other` option. Not for exact lookups, counting, math, or anything a grep answers.",
	"An answer whose confidence comes back below 0.5 is reported as a guess: narrow the state and ask again, or judge it yourself and say that you did. A malformed question block is refused before anything is sent.",
	'The result names the state it judged (`state s7f3a2`). To ask more questions about that same situation, call again with reuse: "s7f3a2" and new questions: the named files are re-read and the command is not re-run.',
].join("\n");

/** `ask_jev` (durable-agent-tools: "In-session judgment tool"): the same
 * contract as the pi judgment extension — state assembly from the agent's own
 * note, named files and a named command's output (both through the run's own
 * execution environment, so a read is scoped to the run's cwd), the question
 * schema validated before any transport, `reuse` handles, and the same
 * "unavailable without a binding" honesty rule. The wire contract itself lives
 * in `./jev.ts`; this registers it as a durable tool. */
export function createAskJevExtension(lookup: RunContextLookup): Extension {
	// Retained states, one map per conversation: a handle belongs to the run that
	// issued it, so a stale handle from an earlier round never resolves here. The
	// four newest are kept, the same bound the pi extension uses.
	// ponytail: a retained state keeps its file contents in memory (bounded per
	// state by MAX_PATHS_PER_CALL × MAX_FILE_BYTES) and the maps are never
	// evicted; cap the total per host if many conversations ever matter.
	const retained = new Map<string, Map<string, RetainedState>>();

	const statesFor = (conversationId: string): Map<string, RetainedState> => {
		const existing = retained.get(conversationId);
		if (existing) return existing;
		const created = new Map<string, RetainedState>();
		retained.set(conversationId, created);
		return created;
	};

	/** A random handle, never a counter: a counter is predictable, and a stale
	 * handle outliving its conversation must not land on another situation. */
	const retain = (
		states: Map<string, RetainedState>,
		state: Omit<RetainedState, "id" | "at">,
	): string => {
		let id = `s${randomUUID().replace(/-/g, "").slice(0, 6)}`;
		while (states.has(id))
			id = `s${randomUUID().replace(/-/g, "").slice(0, 6)}`;
		states.set(id, { ...state, id, at: Date.now() });
		for (const key of [...states.keys()].slice(0, -MAX_RETAINED_STATES))
			states.delete(key);
		return id;
	};

	const describeRetained = (states: Map<string, RetainedState>): string =>
		[...states.values()]
			.map((snapshot) => `${snapshot.id} (${snapshot.summary})`)
			.join("; ") || "none";

	return defineExtension({
		name: "agentic.ask-jev",
		tools: [
			defineTool({
				name: "ask_jev",
				description: ASK_JEV_DESCRIPTION,
				replay: "safe",
				parameters: AskJevParameters,
				execute: async (args, api, context) => {
					const fail = (text: string) => ({
						content: [{ type: "text" as const, text }],
						isError: true,
					});
					const run = lookup(api.conversationId);
					if (!run?.jev)
						return {
							content: [
								{
									type: "text",
									text: "ask_jev: in-session judgment is unavailable (no classifier binding for this run)",
								},
							],
						};
					const questions = validateQuestions(args.questions);
					if (!questions.ok) return fail(`ask_jev: ${questions.error}`);
					const states = statesFor(String(api.conversationId));

					/** Read the named files through the run's own execution
					 * environment. A file that cannot be read, or that is over the
					 * per-file limit, is skipped and reported in the summary rather
					 * than silently truncated: half a file is a different question. */
					const readPaths = async (
						paths: readonly string[],
					): Promise<{ files: Record<string, string>; skipped: string[] }> => {
						const files: Record<string, string> = {};
						const skipped: string[] = [];
						for (const relativePath of paths.slice(0, MAX_PATHS_PER_CALL)) {
							const read = api.env
								? await api.env.readTextFile(
										path.resolve(run.cwd, relativePath),
										context,
									)
								: undefined;
							if (!read?.ok) {
								skipped.push(`${relativePath} (unreadable)`);
								continue;
							}
							if (Buffer.byteLength(read.value, "utf8") > MAX_FILE_BYTES) {
								skipped.push(
									`${relativePath} (over ${MAX_FILE_BYTES / 1024} KiB)`,
								);
								continue;
							}
							files[relativePath] = read.value;
						}
						return { files, skipped };
					};

					let own: Record<string, unknown>;
					let files: Record<string, string> = {};
					let command: CommandOutput | undefined;
					let skipped: string[] = [];
					let reuseNote = "";
					if (args.reuse?.trim()) {
						if (
							args.state !== undefined ||
							args.paths?.length ||
							args.command?.trim()
						)
							return fail(
								"ask_jev: pass reuse on its own. A reuse answers new questions about the state that was already judged; if the situation changed, name state, paths, or command again instead.",
							);
						const snapshot = states.get(args.reuse.trim());
						if (!snapshot)
							return fail(
								`ask_jev: unknown state "${args.reuse.trim()}". Retained here: ${describeRetained(states)}. Nothing was sent.`,
							);
						own = snapshot.own;
						command = snapshot.command;
						const refreshed = await readPaths(snapshot.paths);
						files = refreshed.files;
						skipped = refreshed.skipped;
						reuseNote = `reused ${snapshot.id} (assembled ${ageOf(Date.now() - snapshot.at)}: re-read ${Object.keys(files).length} file(s)${refreshed.skipped.length ? `, skipped ${refreshed.skipped.join(", ")}` : ""}${command ? `; the output of \`${command.command}\` was not re-run` : ""})`;
					} else {
						own = parseOwnState(args.state);
						const ownText = JSON.stringify(own);
						if (ownText.length > MAX_OWN_STATE_CHARS)
							return fail(
								`ask_jev: your own state is ${ownText.length} characters and the limit is ${MAX_OWN_STATE_CHARS}. Do not paste file contents or command output into it; pass paths or command and code fetches them. Nothing was sent.`,
							);
						if (args.paths?.length) {
							const read = await readPaths(args.paths);
							files = read.files;
							skipped = read.skipped;
						}
						if (args.command?.trim()) {
							const name = args.command.trim();
							if (!api.env)
								return fail(
									"ask_jev: this run has no execution environment, so `command` cannot run. Pass the output as state instead.",
								);
							// The environment streams combined stdout/stderr through
							// `onOutput`; the resolved value carries only the exit code and
							// an optional spill path, so the output has to be collected
							// here or the classifier would be asked about a bare exit code.
							let captured = "";
							const result = await api.env.exec(
								name,
								{
									cwd: run.cwd,
									timeout: 30_000,
									onOutput: (text: string) => {
										captured += text;
									},
								},
								context,
							);
							const stdout = captured.slice(0, MAX_OUTPUT_CHARS);
							const note = [
								result.ok
									? ""
									: `the command could not run (${result.error.code})`,
								captured.length > stdout.length
									? `only the first ${MAX_OUTPUT_CHARS} of ${captured.length} characters were judged`
									: "",
							]
								.filter((part) => part.length > 0)
								.join("; ");
							command = {
								command: name,
								exit_code: result.ok ? result.value.exitCode : null,
								stdout,
								stderr: "",
								...(note ? { note } : {}),
							};
						}
					}

					const state = stateOf(own, files, command);
					if (!Object.keys(state).length)
						return fail(
							"ask_jev: nothing to judge. Pass state, paths, or command.",
						);
					const stateChars = JSON.stringify(state).length;
					if (stateChars > MAX_STATE_CHARS)
						return fail(
							`ask_jev: the state is ${stateChars} characters and one call holds ${MAX_STATE_CHARS}. Nothing was sent. Parts, largest first: ${stateParts(files, command)}. Narrow it, or make one call per file.`,
						);
					if (!reuseNote) {
						const summary = summarize(own, files, command, stateChars, skipped);
						const id = retain(states, {
							summary,
							own,
							paths: args.paths ?? [],
							...(command ? { command } : {}),
						});
						reuseNote = `state ${id} · judged ${summary}`;
					}

					let response: Response;
					try {
						response = await fetch(run.jev.endpoint, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								model: run.jev.model,
								state,
								questions: questions.questions,
							}),
							...(context?.abortSignal ? { signal: context.abortSignal } : {}),
						});
					} catch (error) {
						return fail(
							`ask_jev: the classifier could not be reached (${(error as Error).message}). Nothing was decided.`,
						);
					}
					if (!response.ok)
						return fail(
							`ask_jev: the classifier answered ${response.status} ${response.statusText}. Nothing was decided.`,
						);
					const payload = (await response.json()) as {
						answers?: unknown;
						usage?: unknown;
					};
					const answers =
						payload.answers &&
						typeof payload.answers === "object" &&
						!Array.isArray(payload.answers)
							? (payload.answers as Record<string, JsonValue>)
							: {};
					const rendered = renderAnswers(answers, questions.ids);
					const text = [
						`## Jev (provider=${run.jev.provider} model=${run.jev.model})`,
						[reuseNote, usageLine(payload.usage)]
							.filter((part) => part.length > 0)
							.join(" · "),
						"",
						rendered.text,
						...(rendered.warnings.length
							? ["", ...rendered.warnings.map((warning) => `- ${warning}`)]
							: []),
					].join("\n");
					return { content: [{ type: "text", text }], details: { answers } };
				},
			}),
		],
	});
}

const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];

/** Gather `AGENTS.md`/`CLAUDE.md` from `cwd` up to the filesystem root (bounded
 * by `stopAt`, the repository root) and from the global pi agent directory
 * (durable-agent-tools: "System prompt context"). Synchronous `fs` reads: the
 * same contract pi's own context-file loading has (a file, not a committed
 * document), and the section renders once per request preparation. */
export function gatherContextFiles(
	cwd: string,
	stopAt: string,
	globalAgentDir: string,
): string {
	const parts: string[] = [];
	let dir = cwd;
	const boundary = path.resolve(stopAt);
	for (let i = 0; i < 64; i++) {
		for (const name of CONTEXT_FILE_NAMES) {
			const file = path.join(dir, name);
			try {
				parts.push(fs.readFileSync(file, "utf8"));
			} catch {
				/* absent at this level */
			}
		}
		if (path.resolve(dir) === boundary) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const name of CONTEXT_FILE_NAMES) {
		try {
			parts.push(fs.readFileSync(path.join(globalAgentDir, name), "utf8"));
		} catch {
			/* absent */
		}
	}
	return parts.join("\n\n");
}

/** `grep` (durable-agent-tools: "Search tool"): a bounded, repository-scoped
 * pattern search. A durable run's coding tools carry no search of their own, so
 * every scan would otherwise be a `bash` `grep`/`sed` call — one model turn
 * each, with an unbounded result. This returns `path:line: text` hits for a
 * whole scoped path in one call, which is what turns a verifier's review from
 * dozens of turns into a handful. */
export function createSearchExtension(): Extension {
	return defineExtension({
		name: "agentic.search",
		tools: [
			defineTool({
				name: "grep",
				description: [
					"Search the repository for a regular expression and return the matching lines as `path:line: text`. Read-only, bounded to the run's working directory.",
					"Prefer this over `bash` grep/sed: one call covers a whole directory, quoting is not a hazard, and the result is capped instead of spilling.",
					"One call per pattern and several per message: independent searches emitted together cost one turn.",
				].join(" "),
				replay: "safe",
				parameters: GrepParameters,
				async execute(args, api, context) {
					const env = api.env;
					const fail = (text: string) => ({
						content: [{ type: "text" as const, text: `grep: ${text}` }],
						isError: true,
					});
					if (!env) return fail("this run has no execution environment");
					const scoped = scopedSearchPath(args.path);
					if (!scoped.ok) return fail(scoped.why);
					const asked = Number.isFinite(args.maxMatches)
						? Math.floor(args.maxMatches as number)
						: GREP_DEFAULT_MATCHES;
					const limit = Math.min(GREP_MAX_MATCHES, Math.max(1, asked));
					const flags = [
						"--line-number",
						"--no-heading",
						"--color",
						"never",
						...(args.ignoreCase ? ["--ignore-case"] : []),
						...(args.glob ? ["--glob", shellQuote(args.glob)] : []),
					];
					const collect = async (command: string) => {
						let captured = "";
						let truncated = false;
						const result = await env.exec(
							command,
							{
								cwd: env.cwd,
								onOutput: (text: string) => {
									if (truncated) return;
									const room = GREP_MAX_CAPTURE_BYTES - captured.length;
									if (text.length > room) {
										captured += text.slice(0, Math.max(0, room));
										truncated = true;
										return;
									}
									captured += text;
								},
							},
							context,
						);
						return { result, captured, truncated };
					};
					let search = await collect(
						`rg ${flags.join(" ")} -- ${shellQuote(args.pattern)} ${shellQuote(scoped.path)}`,
					);
					// A missing ripgrep (or a run whose environment refuses it) falls
					// back to the platform grep, so a machine without `rg` still
					// searches; exit 1 is "nothing matched" in both tools.
					if (!search.result.ok) {
						const fallbackFlags = [
							"-rnI",
							...(args.ignoreCase ? ["-i"] : []),
							...(args.glob ? [`--include=${shellQuote(args.glob)}`] : []),
						];
						search = await collect(
							`grep ${fallbackFlags.join(" ")} -e ${shellQuote(args.pattern)} ${shellQuote(scoped.path)}`,
						);
						if (!search.result.ok)
							return fail(
								`the search could not run (${search.result.error.code})`,
							);
					}
					// Above 1 both tools report a usage or pattern error rather than a
					// result; their own message is more useful than "no match".
					if (search.result.value.exitCode > 1 && search.captured.trim())
						return fail(search.captured.trim().slice(0, 400));
					const lines = search.captured
						.split("\n")
						.filter((line) => line.length > 0);
					const shown = lines
						.slice(0, limit)
						.map((line) =>
							line.length > GREP_MAX_LINE_CHARS
								? `${line.slice(0, GREP_MAX_LINE_CHARS)}…`
								: line,
						);
					if (shown.length === 0)
						return {
							content: [
								{
									type: "text",
									text: `grep: no match for /${args.pattern}/ in ${scoped.path}`,
								},
							],
						};
					const more = [
						lines.length > shown.length
							? `${lines.length - shown.length} more matching line(s): narrow the path or the pattern, or raise maxMatches.`
							: "",
						search.truncated
							? "the search stopped early after reading a large result: narrow the path or the pattern."
							: "",
					]
						.filter((note) => note.length > 0)
						.map((note) => `… ${note}`)
						.join("\n");
					return {
						content: [
							{
								type: "text",
								text:
									more.length > 0
										? `${shown.join("\n")}\n${more}`
										: shown.join("\n"),
							},
						],
					};
				},
			}),
		],
	});
}

/** The durable system prompt (durable-agent-tools: "System prompt context"):
 * a coding-agent preamble, repository/global context files, and the working
 * directory. `repoRootLookup` resolves a run's repository root for the
 * upward `AGENTS.md`/`CLAUDE.md` walk; absent repos stop at `cwd` itself. */
export function createPromptExtension(
	globalAgentDir: string,
	repoRootLookup: (cwd: string) => string = (cwd) => cwd,
): Extension {
	return defineExtension({
		name: "agentic.prompt",
		sections: [
			section(
				"preamble",
				() =>
					"You are a coding agent running inside a managed agentic-coding workflow. Use the available tools to read and change the repository, run focused checks, and report progress through the workflow's own handoff command.",
				{ tag: false },
			),
			section("cwd", (input) => input.env?.cwd),
			section("context", (input) => {
				const cwd = input.env?.cwd;
				if (!cwd) return undefined;
				const text = gatherContextFiles(
					cwd,
					repoRootLookup(cwd),
					globalAgentDir,
				);
				return text || undefined;
			}),
		],
	});
}
