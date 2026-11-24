import path from "node:path";
import * as z from "zod/v4";
import { identifier } from "./primitives.ts";

const resourceName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

/** Trusted server configuration, never a model-authored resource selector. */
export const dockerServiceBindingSchema = z.strictObject({
	kind: z.literal("docker-container"),
	socket: z.string().min(1).max(4096).refine(path.isAbsolute),
	containerName: resourceName,
	image: z.string().min(1).max(512),
	labels: z
		.record(z.string().min(1).max(256), z.string().max(1024))
		.refine(
			(labels) =>
				Object.keys(labels).length >= 1 && Object.keys(labels).length <= 16,
		),
	network: z.strictObject({ name: resourceName, alias: resourceName }),
	readiness: z.enum(["running", "healthy"]),
	/** Exact configured infrastructure target that may start this absent service. */
	start: z.strictObject({ app: identifier, target: identifier }).optional(),
});

export type DockerServiceBinding = z.output<typeof dockerServiceBindingSchema>;
