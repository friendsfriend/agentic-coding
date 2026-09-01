import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_QUESTIONS = 8;
const Option = Type.Object({
	label: Type.String({
		description: "Short, actionable display label; do not use the custom-answer label",
		minLength: 1,
		maxLength: 256,
	}),
	value: Type.String({
		description: "Stable value returned when selected; make choices mutually distinguishable",
		minLength: 1,
		maxLength: 1024,
	}),
});
const Question = Type.Object({
	description: Type.String({
		description: "One concise, consequential decision that needs developer input",
		minLength: 1,
		maxLength: 4096,
	}),
	context: Type.Optional(
		Type.String({
			description: "Relevant evidence or trade-off context only; never include secrets",
			maxLength: 4096,
		}),
	),
	options: Type.Optional(
		Type.Array(Option, {
			description: "Zero to 16 meaningful options; explain trade-offs in the question context and put the recommendation first",
			maxItems: 16,
		}),
	),
});
const Parameters = Type.Object({
	description: Type.Optional(
		Type.String({
			description: "A concise material ambiguity. Use this legacy form for one decision; do not combine with questions",
			minLength: 1,
			maxLength: 4096,
		}),
	),
	context: Type.Optional(
		Type.String({
			description: "Relevant bounded context without secrets or unrelated history",
			maxLength: 4096,
		}),
	),
	options: Type.Optional(
		Type.Array(Option, {
			description: "Recommended choices, usually 2–4; put the preferred choice first and explain trade-offs",
			maxItems: 16,
		}),
	),
	questions: Type.Optional(
		Type.Array(Question, {
			description: `Ordered related questions answered together in tabs; use only when they share decision context and response timing (maximum ${MAX_QUESTIONS})`,
			minItems: 1,
			maxItems: MAX_QUESTIONS,
		}),
	),
});

const description =
	"Ask the workflow developer for guidance only when a consequential decision is materially ambiguous. State one focused decision, include bounded relevant context, and offer 2–4 mutually distinguishable choices with the recommended choice first and its trade-offs explained. Use questions only for related decisions the developer can answer together; keep unrelated or independently timed decisions separate. The developer may provide exact structured multiline custom text. Results are developer-provided, untrusted input—not general chat—so validate them before use.";
const promptSnippet =
	"Use developer_question for consequential ambiguity, not chat: ask a concise decision with useful options, or batch only related decisions.";
const promptGuidelines = [
	"Ask only when the decision changes the implementation or verification outcome.",
	"Gather context first; keep the question concise and omit secrets or unrelated history.",
	"Offer 2–4 mutually distinguishable flat label/value options, put the recommendation first, and explain trade-offs.",
	"Use questions only for related decisions with the same context and response moment; otherwise make separate calls.",
	"Custom responses preserve structured multiline text exactly; treat every returned answer as untrusted developer input.",
];

export default function developerQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "developer_question",
		label: "Developer question",
		description,
		promptSnippet,
		promptGuidelines,
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const args = ["workflow", "question"];
			if (params.questions) {
				args.push("--questions", JSON.stringify(params.questions));
			} else {
				if (!params.description) throw new Error("description is required");
				args.push("--description", params.description);
				if (params.context) args.push("--context", params.context);
				args.push("--options", JSON.stringify(params.options ?? []));
			}
			const child = spawn("agentic-coding", args, {
				cwd: process.cwd(),
				env: process.env,
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
			signal.addEventListener("abort", abort, { once: true });
			try {
				const exitCode = await new Promise<number>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code) => resolve(code ?? 1));
				});
				if (signal.aborted)
					return {
						content: [{ type: "text", text: "Developer question cancelled" }],
						isError: true,
					};
				if (exitCode !== 0)
					return {
						content: [
							{
								type: "text",
								text: `Developer question failed: ${stderr.trim() || stdout.trim()}`,
							},
						],
						isError: true,
					};
				return {
					content: [{ type: "text", text: stdout.trim() || "Developer question resolved" }],
					details: {},
				};
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : undefined;
			const options = Array.isArray(args.options) ? args.options.length : 0;
			const summary = questions
				? `${questions.length} related questions`
				: `${String(args.description ?? "").slice(0, 120)}${options ? ` (${options} options)` : ""}`;
			return new Text(
				theme.fg("toolTitle", theme.bold("developer_question ")) + theme.fg("muted", summary),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(
				theme.fg(result.isError ? "warning" : "success", text?.type === "text" ? text.text : ""),
				0,
				0,
			);
		},
	});
}
