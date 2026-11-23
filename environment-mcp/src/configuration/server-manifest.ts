import * as z from "zod/v4";
import { executableSchema } from "../domain/execution.ts";
import { action, identifier, runtime } from "./primitives.ts";
import { dockerServiceBindingSchema } from "./service-binding.ts";

export { action, identifier, runtime } from "./primitives.ts";

const absolute = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => value.startsWith("/"));
const defaults = z.strictObject({
	build: identifier.optional(),
	test: identifier.optional(),
	run: identifier.optional(),
});
const dependency = z.strictObject({
	service: identifier,
	lifecycle: z.enum(["shared", "external", "owned"]).default("shared"),
});
const readinessUrl = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				["http:", "https:"].includes(url.protocol) &&
				["127.0.0.1", "[::1]"].includes(url.hostname) &&
				!url.username &&
				!url.password &&
				!url.hash
			);
		} catch {
			return false;
		}
	});
const target = z.strictObject({
	id: identifier,
	action,
	runtime,
	profile: z.string().min(1).max(64).optional(),
	dependsOn: z.array(dependency).max(16).default([]),
	prerequisites: z
		.array(z.strictObject({ app: identifier, target: identifier }))
		.max(16)
		.default([]),
	executable: executableSchema.optional(),
	/** V2 endpoint declarations: loopback application URLs and the Compose
	 * service that owns each one. Readiness stays unknown without a probe. */
	endpoints: z.record(identifier, readinessUrl).default({}),
	endpointServices: z.record(identifier, identifier).default({}),
	/** Sanitized catalog-only reason when this target has no executable plan. */
	executionIssue: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,63}$/)
		.optional(),
});

/** Version 1 manifest: selection/dependency declarations, not executable authority.
 * Runtime execution descriptors are a later reviewed controller boundary. */
export const serverManifestSchema = z
	.strictObject({
		version: z.literal(1),
		repositories: z.array(absolute).min(1).max(64),
		services: z
			.array(
				z.strictObject({
					id: identifier,
					runtime,
					binding: dockerServiceBindingSchema.optional(),
				}),
			)
			.max(64)
			.default([]),
		apps: z
			.array(
				z.strictObject({
					id: identifier,
					repository: absolute,
					kind: z.enum(["app", "library", "infrastructure"]).default("app"),
					defaults: defaults.default({}),
					targets: z.array(target).max(256),
				}),
			)
			.max(64),
	})
	.superRefine((manifest, context) => {
		const unique = (values: string[]) => new Set(values).size === values.length;
		const services = new Set(manifest.services.map((service) => service.id));
		if (
			manifest.services.some(
				(service) => service.binding && service.runtime !== "docker",
			)
		)
			context.addIssue({
				code: "custom",
				message: "Service binding runtime mismatch",
			});
		if (
			!unique(manifest.repositories) ||
			!unique(manifest.apps.map((app) => app.id)) ||
			services.size !== manifest.services.length
		)
			context.addIssue({
				code: "custom",
				message: "Duplicate manifest identity",
			});
		if (
			manifest.apps.reduce((count, app) => count + app.targets.length, 0) > 256
		)
			context.addIssue({ code: "custom", message: "Target limit exceeded" });
		for (const app of manifest.apps) {
			if (
				!manifest.repositories.includes(app.repository) ||
				!unique(app.targets.map((target) => target.id))
			)
				context.addIssue({
					code: "custom",
					message: "Invalid application identity",
				});
			for (const [action, id] of Object.entries(app.defaults))
				if (
					!app.targets.some(
						(target) => target.id === id && target.action === action,
					)
				)
					context.addIssue({
						code: "custom",
						message: "Invalid default selection",
					});
			for (const target of app.targets)
				if (
					!unique(target.dependsOn.map((dependency) => dependency.service)) ||
					target.dependsOn.some(
						(dependency) => !services.has(dependency.service),
					)
				)
					context.addIssue({
						code: "custom",
						message: "Unknown or duplicate dependency",
					});
			for (const target of app.targets) {
				const endpointNames = Object.keys(target.endpoints);
				const composeServices =
					target.executable?.kind === "compose"
						? new Set(target.executable.services)
						: new Set<string>();
				if (
					endpointNames.length &&
					(target.action !== "run" ||
						target.runtime !== "compose" ||
						target.executable?.kind !== "compose" ||
						endpointNames.some(
							(name) => !Object.hasOwn(target.endpointServices, name),
						) ||
						Object.entries(target.endpointServices).some(
							([name, service]) =>
								!endpointNames.includes(name) || !composeServices.has(service),
						))
				)
					context.addIssue({
						code: "custom",
						message: "Compose endpoints require one matching service selector",
					});
				if (
					target.executable?.kind === "container-run" &&
					(target.action !== "run" ||
						!["docker", "podman"].includes(target.runtime))
				)
					context.addIssue({
						code: "custom",
						message: "Container run requires a run Docker/Podman target",
					});
				if (
					target.executable?.kind === "process" &&
					(target.action !== "run" ||
						!["shell", "systemshell"].includes(target.runtime))
				)
					context.addIssue({
						code: "custom",
						message: "Process executable requires a run shell target",
					});
				if (
					target.executable?.kind === "compose" &&
					(target.action !== "run" || target.runtime !== "compose")
				)
					context.addIssue({
						code: "custom",
						message: "Compose executable requires a run/compose target",
					});
				if (
					target.executable?.kind === "helm-release" &&
					(target.action !== "run" || target.runtime !== "kubernetes")
				)
					context.addIssue({
						code: "custom",
						message: "Helm executable requires a run/kubernetes target",
					});
				if (
					target.executable?.kind === "network-only" &&
					(target.action !== "run" ||
						target.runtime !== "compose" ||
						Object.keys(target.endpoints).length > 0)
				)
					context.addIssue({
						code: "custom",
						message: "Network-only executable requires a run/compose target",
					});
				if (
					target.executable?.kind === "command" &&
					!target.executable.program.startsWith("/")
				)
					context.addIssue({
						code: "custom",
						message: "Command program must be an absolute path",
					});
			}
		}
	});
export type ServerManifest = z.output<typeof serverManifestSchema>;
