// Tool and prompt surface of a durable agent run (durable-agent-tools spec):
// coding tools + read-only policy, the workflow dialogue tools
// (`developer_question`, `agent_ask`), the in-session judgment tool
// (`ask_jev`), and the system prompt context. Built against pi-durable's
// `defineExtension`/`defineTool`/`section` so every durable conversation gets
// the same contract the pi workflow extension gives a `pi` run
// (agent-definitions/extensions/developer-question.ts, ask-jev.ts).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type Extension,
	section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

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

const MAX_QUESTIONS = 12;
const MAX_OWN_STATE_CHARS = 8_000;
const MAX_PATHS_PER_CALL = 20;
const MAX_FILE_BYTES = 96 * 1024;
const LOW_CONFIDENCE = 0.5;
const AskJevParameters = Type.Object({
	state: Type.Optional(Type.Unknown()),
	paths: Type.Optional(
		Type.Array(Type.String(), { maxItems: MAX_PATHS_PER_CALL }),
	),
	command: Type.Optional(Type.String()),
	questions: Type.Unknown(),
});

/** `ask_jev` (durable-agent-tools: "In-session judgment tool"). A narrowed
 * port of `agent-definitions/extensions/ask-jev.ts`: state assembly from the
 * agent's own note, named files (read through the run's own execution
 * environment, so a file read is scoped to the run's cwd) and a named
 * command's output (run the same way), one call per situation, and the same
 * "unavailable without a binding" honesty rule. `reuse`-by-handle across
 * calls is not implemented in this pass (every call assembles state fresh). */
export function createAskJevExtension(lookup: RunContextLookup): Extension {
	return defineExtension({
		name: "agentic.ask-jev",
		tools: [
			defineTool({
				name: "ask_jev",
				description:
					"Ask the run's own configured classifier typed questions about files, a command's output, or your own state. Answers are judgments, not evidence.",
				replay: "safe",
				parameters: AskJevParameters,
				execute: async (args, api, context) => {
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
					if (!args.questions || typeof args.questions !== "object")
						return {
							content: [
								{
									type: "text",
									text: "ask_jev: questions must be a non-empty object keyed by question id",
								},
							],
							isError: true,
						};
					const ids = Object.keys(args.questions as Record<string, unknown>);
					if (!ids.length || ids.length > MAX_QUESTIONS)
						return {
							content: [
								{
									type: "text",
									text:
										"ask_jev: questions must have 1-" +
										MAX_QUESTIONS +
										" entries",
								},
							],
							isError: true,
						};
					const state: Record<string, unknown> = {};
					if (args.state !== undefined) {
						const own =
							typeof args.state === "string"
								? args.state
								: JSON.stringify(args.state);
						state.state =
							own.length > MAX_OWN_STATE_CHARS
								? own.slice(0, MAX_OWN_STATE_CHARS)
								: own;
					}
					if (args.paths?.length) {
						const files: Record<string, string> = {};
						for (const relativePath of args.paths.slice(
							0,
							MAX_PATHS_PER_CALL,
						)) {
							const resolved = path.resolve(run.cwd, relativePath);
							const read = api.env
								? await api.env.readTextFile(resolved, context)
								: undefined;
							if (read?.ok)
								files[relativePath] = read.value.slice(0, MAX_FILE_BYTES);
						}
						state.files = files;
					}
					if (args.command) {
						const result = api.env
							? await api.env.exec(
									args.command,
									{ cwd: run.cwd, timeout: 30_000 },
									context,
								)
							: undefined;
						state.output = {
							command: args.command,
							exit_code: result?.ok ? result.value.exitCode : null,
							note: result?.ok ? undefined : "command could not run",
						};
					}
					let response: Response;
					try {
						response = await fetch(run.jev.endpoint, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								model: run.jev.model,
								state,
								questions: args.questions,
							}),
						});
					} catch (error) {
						return {
							content: [
								{
									type: "text",
									text:
										"ask_jev: the classifier could not be reached (" +
										(error as Error).message +
										")",
								},
							],
							isError: true,
						};
					}
					if (!response.ok)
						return {
							content: [
								{
									type: "text",
									text:
										"ask_jev: the classifier answered " +
										response.status +
										" " +
										response.statusText,
								},
							],
							isError: true,
						};
					const payload = (await response.json()) as {
						answers?: Record<string, { confidence?: number }>;
					};
					const answers = payload.answers ?? {};
					const low = Object.entries(answers).filter(
						([, answer]) => (answer?.confidence ?? 1) < LOW_CONFIDENCE,
					);
					const text = [
						"## Jev (provider=" +
							run.jev.provider +
							" model=" +
							run.jev.model +
							")",
						JSON.stringify(answers, null, 2),
						...(low.length
							? [`- low confidence: ${low.map(([id]) => id).join(", ")}`]
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
