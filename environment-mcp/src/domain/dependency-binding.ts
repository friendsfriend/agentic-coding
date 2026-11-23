import * as z from "zod/v4";
import type { DockerServiceBinding } from "../configuration/service-binding.ts";

export class DependencyBindingRefusal extends Error {
	constructor(
		readonly code:
			| "dependency-observation-unavailable"
			| "dependency-identity-mismatch"
			| "dependency-not-ready"
			| "dependency-binding-required"
			| "dependency-start-required"
			| "external-unavailable"
			| "dependency-owner-unavailable"
			| "dependency-generation-changed"
			| "dependency-preparation-unavailable",
	) {
		super(code);
	}
}

export type ContainerInspection =
	| { status: "absent" }
	| { status: "present"; document: unknown };
export interface ContainerInspectionPort {
	inspect(
		binding: DockerServiceBinding,
		signal: AbortSignal,
	): Promise<ContainerInspection>;
}

const resourceId = z.string().regex(/^[a-f0-9]{64}$/);
const inspectionSchema = z.object({
	Id: resourceId,
	Created: z.string().min(1).max(128),
	Name: z.string().min(1).max(256),
	Image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	Config: z.object({
		Image: z.string(),
		Labels: z.record(z.string(), z.string()).nullable(),
	}),
	State: z.object({
		StartedAt: z.string().min(1).max(128),
		Running: z.boolean(),
		Paused: z.boolean(),
		Restarting: z.boolean(),
		Dead: z.boolean(),
		Health: z
			.object({ Status: z.enum(["starting", "healthy", "unhealthy", "none"]) })
			.optional(),
	}),
	NetworkSettings: z.object({
		Networks: z.record(
			z.string(),
			z.object({
				NetworkID: resourceId,
				Aliases: z.array(z.string()).nullable(),
			}),
		),
	}),
});

/** Projection excludes Env, mounts, command arguments, health logs and other
 * inspector fields that can contain credentials. It grants no cleanup handle. */
export function matchBorrowedContainer(
	binding: DockerServiceBinding,
	document: unknown,
) {
	const parsed = inspectionSchema.safeParse(document);
	if (!parsed.success)
		throw new DependencyBindingRefusal("dependency-observation-unavailable");
	const container = parsed.data;
	const network = container.NetworkSettings.Networks[binding.network.name];
	if (
		container.Name !== `/${binding.containerName}` ||
		container.Config.Image !== binding.image ||
		Object.entries(binding.labels).some(
			([key, value]) => container.Config.Labels?.[key] !== value,
		) ||
		!network?.Aliases?.includes(binding.network.alias)
	)
		throw new DependencyBindingRefusal("dependency-identity-mismatch");
	return {
		ready:
			container.State.Running &&
			!container.State.Paused &&
			!container.State.Restarting &&
			!container.State.Dead &&
			(binding.readiness === "running" ||
				container.State.Health?.Status === "healthy"),
		identity: {
			container: container.Id,
			createdAt: container.Created,
			startedAt: container.State.StartedAt,
			image: container.Image,
			network: network.NetworkID,
			alias: binding.network.alias,
		},
	};
}
