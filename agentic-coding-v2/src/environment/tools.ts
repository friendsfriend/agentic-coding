import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { toolResult } from "../agent-tools.ts";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import { type Action, resolvePlans } from "./catalog.ts";
import type { Environments } from "./manager.ts";

function environmentResult(value: unknown) {
	const encoded = JSON.stringify(value);
	return toolResult(
		encoded.length > 40000
			? `${encoded.slice(0, 39500)}\n[truncated; narrow env_status/env_logs to an app]`
			: encoded,
	);
}
export const environmentInspectionTools = new Set([
	"env_list",
	"env_status",
	"env_logs",
]);
export function createEnvironmentTools(
	manager: Environments,
	ownerOf: (id: ConversationId) => Promise<TaskInfo | null>,
) {
	async function execute(
		action: Action,
		apps: string[],
		target: string | undefined,
		timeoutSec: number,
		api: ToolExecutionApi,
		context: Context,
	) {
		const owner = await ownerOf(api.conversationId);
		if (!owner)
			throw new Error("Environment execution requires a native skill task");
		const batch = `env-${api.taskId}`,
			request = JSON.stringify({
				action,
				apps,
				target: target ?? null,
				timeoutSec,
			});
		const previous = await manager.receipt(batch, owner.id, request);
		if (previous) return environmentResult(previous);
		const plans = resolvePlans(manager.projects, owner, apps, action, target);
		const snapshot = JSON.stringify(
			{
				plans,
				waitTimeoutMs: timeoutSec * 1000,
				authority:
					"Execute these exact shell commands in the task workspace. Not an OS sandbox. Only conventional PATH/HOME/LANG/TMPDIR/TERM plus the displayed literal variables, referenced secrets, WORKSPACE and CONFIG_DIR are passed. Run targets last until stopped, task completion/cancellation or host shutdown. No automatic replay after ambiguous interruption.",
			},
			null,
			2,
		);
		const review = await requestReview(
			owner,
			{
				title: `Environment ${action}: ${apps.join(", ")}`,
				path: owner.workspace,
				snapshot,
			},
			api,
			context,
		);
		if (review.state !== "approved" || review.snapshot !== snapshot)
			throw new Error("Exact current environment plan was not approved");
		return environmentResult(
			await manager.execute(
				batch,
				request,
				owner,
				plans,
				timeoutSec * 1000,
				context.abortSignal,
			),
		);
	}
	const target = Type.Optional(Type.String({ maxLength: 64 }));
	return defineExtension({
		name: "v2.environments",
		tools: [
			defineTool({
				name: "env_list",
				description:
					"List configured environment projects and shell targets, current task-owned slots and acquisition queues. No live legacy environments are imported.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => environmentResult(await manager.snapshot()),
			}),
			defineTool({
				name: "env_status",
				description:
					"Inspect environment run receipts, process exit status, readiness and task ownership. Interrupted effects require developer inspection; never kill a saved PID.",
				parameters: Type.Object({ app: Type.Optional(Type.String()) }),
				replay: "safe",
				execute: async (args) =>
					environmentResult(await manager.snapshot(args.app)),
			}),
			defineTool({
				name: "env_logs",
				description:
					"Read bounded, known-secret-redacted complete log lines from this task's environment executions. The home orchestrator may inspect all host runs. In-progress unterminated lines are withheld.",
				parameters: Type.Object({ app: Type.String() }),
				replay: "safe",
				execute: async (args, api) =>
					environmentResult(
						await manager.logs(
							args.app,
							(await ownerOf(api.conversationId))?.id,
						),
					),
			}),
			defineTool({
				name: "env_start",
				description:
					"Request human approval for exact configured run commands and acquire all apps atomically in FIFO order. Only this task's repository/workspace is allowed. Release an existing batch before acquiring more apps. Startup readiness is checked only when readyText is configured. Acquisition timeout releases queue position; no app starts on timeout.",
				parameters: Type.Object({
					apps: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
					target,
					timeoutSec: Type.Optional(
						Type.Integer({ minimum: 1, maximum: 7200 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) =>
					execute(
						"run",
						args.apps,
						args.target,
						args.timeoutSec ?? 30,
						api,
						context,
					),
			}),
			...(["build", "test"] as const).map((action) =>
				defineTool({
					name: `env_${action}`,
					description: `Request human approval and execute one configured ${action} target in this task's workspace, returning exit status and redacted output. Requires no app slot; one build/test action at a time per workspace. Action timeouts are configured per target.`,
					parameters: Type.Object({ app: Type.String(), target }),
					replay: "safe",
					executionMode: "sequential",
					execute: async (args, api, context) =>
						execute(action, [args.app], args.target, 30, api, context),
				}),
			),
			defineTool({
				name: "env_stop",
				description:
					"Stop only apps started by this task, with live process-group cleanup before release. Never stops another task's apps or acts on a persisted PID. Also cancels matching pending acquisitions.",
				parameters: Type.Object({
					apps: Type.Optional(
						Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api) => {
					const owner = await ownerOf(api.conversationId);
					if (!owner)
						throw new Error(
							"Stopping environments requires their owning skill task",
						);
					return environmentResult({
						stopped: await manager.stopOnce(
							`env-stop-${api.taskId}`,
							owner.id,
							args.apps,
						),
					});
				},
			}),
		],
	});
}
