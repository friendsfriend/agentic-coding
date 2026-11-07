import {
	type ConversationId,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import type { Config } from "./config.ts";
import { captureAttachment } from "./evidence-capture.ts";
import { captureReview, contained } from "./git.ts";
import { requestReview } from "./reviews.ts";
import { Catalog, type TaskInfo } from "./state.ts";

export const toolResult = (value: unknown) => ({
	output: [
		{
			type: "text" as const,
			text: typeof value === "string" ? value : JSON.stringify(value),
		},
	],
});
export type OwnerLookup = (id: ConversationId) => Promise<TaskInfo>;

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
				name: "attach_image",
				description:
					"Store a PNG, JPEG, WebP or GIF from this task's workspace and return an inline Markdown image reference.",
				parameters: Type.Object({
					path: Type.String(),
					caption: Type.String(),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					return toolResult(
						await captureAttachment(
							config,
							owner,
							{ ...args, kind: "image" },
							api,
							context,
						),
					);
				},
			}),
			defineTool({
				name: "attach_evidence",
				description:
					"Retain an image, UTF-8 log/script/report/JSON, ZIP trace or WebM/MP4 from this task workspace (10 MB maximum). Files are never executed, extracted or independently certified as evidence.",
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

/** File tools enforce the task path boundary; an arbitrary shell is never implicitly authorized. */
export function createTaskCodingTools(ownerOf: OwnerLookup) {
	const read = createReadTool();
	const write = createWriteTool();
	const edit = createEditTool();
	const bash = createBashTool();
	return defineExtension({
		name: "v2.coding",
		tools: [
			defineTool({
				...read,
				execute: async (args, api, context) => {
					contained((await ownerOf(api.conversationId)).workspace, args.path);
					return read.execute(args, api, context);
				},
			}),
			defineTool({
				...write,
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (owner.policy !== "workspace-write")
						throw new Error("Task policy forbids writes");
					contained(owner.workspace, args.path);
					return write.execute(args, api, context);
				},
			}),
			defineTool({
				...edit,
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (owner.policy !== "workspace-write")
						throw new Error("Task policy forbids writes");
					contained(owner.workspace, args.path);
					return edit.execute(args, api, context);
				},
			}),
			defineTool({
				...bash,
				replay: "safe" as const,
				description: `${bash.description} Every exact command requires human approval. A started command is never rerun automatically after interruption.`,
				execute: async (args, api, context) => {
					const owner = await ownerOf(api.conversationId);
					if (owner.policy !== "workspace-write")
						throw new Error("Task policy forbids shell execution");
					const snapshot = `Unsandboxed local shell command (may access the host and network).\nApprove only if its effects are authorized.\n\nWorking directory: ${owner.workspace}\nTimeout: ${args.timeout ?? "default"}\n\n${args.command}`;
					const decision = await requestReview(
						owner,
						{
							path: "[shell command]",
							title: "Authorize exact shell command",
							snapshot,
						},
						api,
						context,
					);
					if (decision.state !== "approved")
						throw new Error(
							`Shell command not authorized: ${decision.state}. ${decision.comments}`,
						);
					await api.commit(async (tx) => {
						const doc = await tx.doc(Catalog);
						const id = String(api.taskId);
						if (doc.shellStarts[id])
							throw new Error(
								"Command execution was already started; its outcome may be unknown. Inspect effects before issuing a new command.",
							);
						doc.shellStarts[id] = decision.digest;
					}, context);
					return bash.execute(args, api, context);
				},
			}),
		],
	});
}
