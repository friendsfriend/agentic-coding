import * as z from "zod/v4";
import {
	action,
	identifier,
	runtime,
	type ServerManifest,
} from "../configuration/server-manifest.ts";

/** Explicit metadata-only compatibility reader. Unknown execution fields are
 * discarded, not validated, migrated, returned or authorized for dispatch. */
const catalogSchema = z.object({
	version: z.literal(1),
	projects: z
		.array(
			z.object({
				id: identifier,
				repository: z.string().min(1).max(4096),
				kind: z.enum(["app", "library", "infrastructure"]),
				defaults: z
					.object({
						build: identifier.optional(),
						test: identifier.optional(),
						run: identifier.optional(),
					})
					.default({}),
				targets: z
					.array(
						z.object({
							id: identifier,
							action,
							runtime,
							profile: z.string().min(1).max(64).optional(),
						}),
					)
					.max(256),
			}),
		)
		.max(64),
});

export function importV2CatalogMetadata(
	raw: unknown,
	repositories: string[],
): ServerManifest {
	const data = catalogSchema.parse(raw);
	return {
		version: 1,
		repositories,
		services: [],
		apps: data.projects.map((project) => ({
			...project,
			targets: project.targets.map((target) => ({
				...target,
				dependsOn: [],
				prerequisites: [],
				endpoints: {},
				endpointServices: {},
			})),
		})),
	};
}
