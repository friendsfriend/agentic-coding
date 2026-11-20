import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { BoundEnvironmentController } from "../environment/controller/service.ts";
import { definitionProjectLimit } from "../environment/definition-limits.ts";
import { CatalogRefusal, type EnvironmentCatalog } from "./catalog.ts";
import { registerEnvironmentDiagnostics } from "./diagnostics.ts";
import { registerEnvironmentExecution } from "./execution.ts";

const repository = z.string().min(1).max(4096);
const outputSchema = z.record(z.string(), z.unknown());

function inspect(operation: () => Record<string, unknown>) {
	try {
		const structuredContent = operation();
		const text = JSON.stringify(structuredContent);
		if (Buffer.byteLength(text) > 131072)
			throw new CatalogRefusal("catalog-unavailable");
		return { content: [{ type: "text" as const, text }], structuredContent };
	} catch (error) {
		const code =
			error instanceof CatalogRefusal ? error.code : "catalog-unavailable";
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `Environment inspection refused: ${code}`,
				},
			],
		};
	}
}

export function createEnvironmentMcpServer(
	catalog: EnvironmentCatalog,
	controller?: BoundEnvironmentController,
) {
	const server = new McpServer({
		name: "agentic-environments",
		version: "0.1.0",
	});
	const annotations = {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};
	server.registerTool(
		"env_list",
		{
			description:
				"List configured environment targets and authorized repository paths. Inspection only: no commands, secret values, runtime probes or execution. Availability is local metadata, not health. Follow nextOffset for more projects.",
			inputSchema: z.strictObject({
				repository: repository.optional(),
				offset: z.number().int().min(0).max(definitionProjectLimit).default(0),
				limit: z.number().int().min(1).max(10).default(10),
			}),
			outputSchema,
			annotations,
		},
		async (input) => {
			await controller?.touch();
			return inspect(() => catalog.list(input));
		},
	);
	server.registerTool(
		"env_discover",
		{
			description:
				"Inspect bounded public manifests in one authorized repository directory for untrusted environment hints. No execution, secrets, definition writes, readiness or approval. Use an exact repository path returned by env_list.",
			inputSchema: z.strictObject({
				repository,
				directory: z.string().min(1).max(1024).default("."),
			}),
			outputSchema,
			annotations,
		},
		async (input) => {
			await controller?.touch();
			return inspect(() => catalog.discover(input));
		},
	);
	if (controller) {
		registerEnvironmentExecution(server, controller);
		registerEnvironmentDiagnostics(server, controller);
	}
	return server;
}
