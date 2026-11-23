import * as z from "zod/v4";

const runtimeId = z.string().min(1).max(512);

/** A resource this controller actually created under an issued operation.
 * Borrowed/shared/external observations are never recorded here and therefore
 * can never enter cleanup. No saved record restores a process handle on restart. */
export const ownedResourceSchema = z.strictObject({
	id: z.uuid(),
	scope: z.uuid(),
	operation: z.uuid(),
	app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	kind: z.enum(["container", "image", "process", "helm-release", "network"]),
	runtimeId,
	createdAt: z.number().int(),
});
export type OwnedResource = z.output<typeof ownedResourceSchema>;

export class CleanupRefusal extends Error {
	constructor(
		readonly code:
			| "owned-resource-unavailable"
			| "owned-resource-foreign"
			| "cleanup-unavailable",
	) {
		super(code);
	}
}
