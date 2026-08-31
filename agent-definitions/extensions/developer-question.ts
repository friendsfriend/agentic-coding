import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const Option = Type.Object({
	label: Type.String({
		description: "Short display label",
		minLength: 1,
		maxLength: 256,
	}),
	value: Type.String({
		description: "Value returned when selected",
		minLength: 1,
		maxLength: 1024,
	}),
});
const Parameters = Type.Object({
	description: Type.String({
		description: "The ambiguity that needs developer input",
		minLength: 1,
		maxLength: 4096,
	}),
	options: Type.Optional(
		Type.Array(Option, {
			description: "Recommended choices; custom text is always available",
			maxItems: 16,
		}),
	),
});

export default function developerQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "developer_question",
		label: "Developer question",
		description:
			"Ask the workflow developer for guidance when the plan or findings leave an important ambiguity.",
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const args = [
				"workflow",
				"question",
				"--description",
				params.description,
				"--options",
				JSON.stringify(params.options ?? []),
			];
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
					content: [
						{
							type: "text",
							text: stdout.trim() || "Developer question resolved",
						},
					],
					details: {},
				};
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		renderCall(args, theme) {
			const options = Array.isArray(args.options) ? args.options.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("developer_question ")) +
					theme.fg(
						"muted",
						`${args.description}${options ? ` (${options} recommended options)` : ""}`,
					),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(
				theme.fg(
					result.isError ? "warning" : "success",
					text?.type === "text" ? text.text : "",
				),
				0,
				0,
			);
		},
	});
}
