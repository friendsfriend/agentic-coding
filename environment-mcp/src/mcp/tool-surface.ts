import type { EnvironmentCapabilities } from "../interface/capabilities.ts";

/** MCP's derived surface. It is computed from the same registry as the UI and
 * never contains a hand-written action list. */
export function mcpToolSurface(capabilities: EnvironmentCapabilities) {
	return capabilities.list().map((capability) => ({
		name: capability.name,
		config: {
			description: capability.description,
			inputSchema: capability.inputSchema,
			outputSchema: capability.outputSchema,
			annotations: capability.annotations,
		},
	}));
}
