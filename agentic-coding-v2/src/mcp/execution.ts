import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BoundEnvironmentController } from "../environment/controller/service.ts";
import { ControllerRefusal } from "../environment/controller/state.ts";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const apps = z.array(identifier).min(1).max(16);
const requestId = z.string().trim().min(1).max(256);
const actionSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.enum(["run", "build", "test"]),
		apps,
		requestId,
		target: z.string().min(1).max(200).optional(),
		profile: z.string().min(1).max(64).optional(),
		runtime: z
			.enum([
				"shell",
				"systemshell",
				"docker",
				"podman",
				"compose",
				"kubernetes",
			])
			.optional(),
		replicas: z.number().int().min(1).max(16).optional(),
		lifetime: z
			.enum([
				"independent-roots-v1",
				"referenced-roots-v1",
				"shared-prerequisites-v1",
			])
			.optional(),
		timeoutSec: z.number().int().min(1).max(7200).optional(),
	}),
	z.strictObject({ action: z.literal("execute"), operationId: z.uuid() }),
	z.strictObject({
		action: z.literal("close"),
		requestId,
		revision: z.number().int().min(1),
	}),
	z.strictObject({
		action: z.literal("stop"),
		requestId,
		apps: apps.optional(),
	}),
]);
export const outputSchema = z.record(z.string(), z.unknown());

export async function respond(
	operation: () => Promise<Record<string, unknown>>,
) {
	try {
		const structuredContent = await operation();
		const text = JSON.stringify(structuredContent);
		if (Buffer.byteLength(text) > 131072)
			throw new ControllerRefusal("operation-unavailable");
		return { content: [{ type: "text" as const, text }], structuredContent };
	} catch (error) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `Environment request refused: ${error instanceof ControllerRefusal ? error.code : "operation-unavailable"}`,
				},
			],
		};
	}
}

/** Only install after the embedding host authenticated and fixed this client's scope. */
export function registerEnvironmentExecution(
	server: McpServer,
	controller: BoundEnvironmentController,
) {
	server.registerTool(
		"environment_action",
		{
			description:
				"Request a frozen run/build/test plan for human approval. Admission does not execute. After separate operator approval, action execute dispatches the returned environment/HTTP/SQL operationId once. Stop cleans this scope's original live resources. Close permanently fences this scope and joins cleanup; use its current revision from env_status. No approval, owner or arbitrary command arguments are accepted.",
			inputSchema: actionSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		(input) =>
			respond(async () => {
				if (input.action === "execute")
					return controller.execute(input.operationId);
				if (input.action === "stop")
					return controller.stop(input.requestId, input.apps);
				if (input.action === "close")
					return controller.closeScope(input.requestId, input.revision);
				const { requestId, ...intent } = input;
				return controller.admit(requestId, intent);
			}),
	);
	server.registerTool(
		"env_result",
		{
			description:
				"Read one operation's current durable receipt in this bound scope. This is an immediate observation, not a polling loop, wait, execution or permission grant. Issued is pending or uncertain, never proof of startup success.",
			inputSchema: z.strictObject({ operationId: z.uuid() }),
			outputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ operationId }) => respond(() => controller.result(operationId)),
	);
	server.registerTool(
		"env_status",
		{
			description:
				"Read bounded run status and scope revision for this client only. Direct agent reads count as active-scope idle activity; operator reads do not. Historical records never restore live authority. Readiness is the declared observation, not independent verification of application behavior.",
			inputSchema: z.strictObject({ app: identifier.optional() }),
			outputSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ app }) => respond(() => controller.status(app)),
	);
}
