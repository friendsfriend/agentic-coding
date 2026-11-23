import * as z from "zod/v4";
import type { Capability, CapabilityAnnotations } from "./capabilities.ts";

export type JsonSchema = Record<string, unknown>;

/** Transport-neutral description of one capability. The MCP tool and the UI
 * action both derive from the capability registry, so this descriptor never
 * contains a handler or a second action table. */
export type ActionDescriptor = {
	name: string;
	label: string;
	description: string;
	annotations: CapabilityAnnotations;
	inputSchema: JsonSchema;
};

const annotationsSchema = z.strictObject({
	readOnlyHint: z.boolean().optional(),
	destructiveHint: z.boolean().optional(),
	idempotentHint: z.boolean().optional(),
	openWorldHint: z.boolean().optional(),
});
export const actionDescriptorSchema = z.strictObject({
	name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	label: z.string().min(1).max(128),
	description: z.string().min(1).max(4096),
	annotations: annotationsSchema,
	inputSchema: z.record(z.string(), z.unknown()),
});
export const actionListSchema = z.strictObject({
	actions: z.array(actionDescriptorSchema).max(64),
});

export function describeAction(capability: Capability): ActionDescriptor {
	const { $schema: _version, ...inputSchema } = z.toJSONSchema(
		capability.inputSchema,
		{ io: "input", unrepresentable: "any" },
	);
	return {
		name: capability.name,
		label: capability.ui.label,
		description: capability.description,
		annotations: capability.annotations,
		inputSchema,
	};
}
