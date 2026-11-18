import {
	type ConversationId,
	defineExtension,
	defineTool,
	type Extension,
} from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import type { Config } from "./config.ts";
import { captureAttachment } from "./evidence-capture.ts";
import { captureReview } from "./git.ts";
import { requestReview } from "./reviews.ts";
import type { TaskInfo } from "./state.ts";

export const toolResult = (value: unknown) => ({
	output: [
		{
			type: "text" as const,
			text: typeof value === "string" ? value : JSON.stringify(value),
		},
	],
});
export type OwnerLookup = (id: ConversationId) => Promise<TaskInfo>;

/** The runtime's own file and shell tools, offered as they are. A task works in
 * its own isolated workspace and an orchestrator in its own checkout, so neither
 * needs a wrapped copy: no containment rewrite, no approval inserted in front of
 * a command, no rewritten replay rule. `bash` keeps the runtime default, which
 * never re-runs an interrupted command.
 *
 * `powershell` is the same tool on a Windows host, where the shell is PowerShell;
 * elsewhere it would be a tool that can only fail, so it is not offered. */
export function createCodingTools(): Extension {
	return defineExtension({
		name: "v2.coding",
		tools: [
			createReadTool(),
			createWriteTool(),
			createEditTool(),
			createBashTool(),
			...(process.platform === "win32" ? [createPowerShellTool()] : []),
		],
	});
}

export function createAgentTools(config: Config, ownerOf: OwnerLookup) {
	return defineExtension({
		name: "v2.agent-tools",
		tools: [
			defineTool({
				name: "request_review",
				description:
					"Capture a path's Git diff and wait for an authenticated human decision. Approval is for the immutable snapshot only.",
				parameters: Type.Object({ path: Type.String(), title: Type.String() }),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					return toolResult(
						await requestReview(
							owner,
							{
								path: args.path,
								title: args.title,
								snapshot: async () =>
									(await captureReview(owner.workspace, args.path)).snapshot,
							},
							api,
							context,
						),
					);
				},
			}),
			defineTool({
				name: "attach_evidence",
				description:
					"Retain one file from this task's workspace as task-owned evidence: a PNG, JPEG, WebP or GIF image, a UTF-8 log, script, report or JSON, a ZIP trace or a WebM/MP4 video (10 MB maximum). Answers with a durable markdown reference — `![caption](/attachments/<sha256>)` for an image, a link otherwise — which the transcript renders and an authenticated client serves; naming that reference in the final answer is how a task hands the file to its orchestrator and the developer. Bytes are copied out of the workspace, so the file outlives the task; they are never executed, extracted or independently certified.",
				parameters: Type.Object({
					path: Type.String(),
					caption: Type.String(),
					kind: Type.Union(
						["image", "log", "script", "report", "json", "trace", "video"].map(
							(kind) => Type.Literal(kind),
						),
					),
				}),
				replay: "safe",
				execute: async (args, api, context) =>
					toolResult(
						await captureAttachment(
							config,
							await ownerOf(api.conversationId),
							args,
							api,
							context,
						),
					),
			}),
		],
	});
}
