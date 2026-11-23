import fs from "node:fs";
import path from "node:path";
import { importV2CatalogMetadata } from "../compatibility/v2-catalog.ts";
import { readConfigurationJson } from "../configuration/read-json.ts";
import { serverManifestSchema } from "../configuration/server-manifest.ts";
import { readV2Configuration } from "../configuration/v2-configuration.ts";

export type CatalogSourceOptions = {
	file: string;
	format: "manifest" | "v2-catalog" | "v2-config";
	repositories: string[];
};

export function createCatalogService(options: CatalogSourceOptions) {
	if (!path.isAbsolute(options.file))
		throw new Error("Absolute configuration path required");
	const v2Full =
		options.format === "v2-config"
			? readV2Configuration(path.dirname(options.file), options.repositories)
			: undefined;
	const configuredRoots =
		v2Full?.repositories ??
		(options.format === "manifest"
			? serverManifestSchema.parse(readConfigurationJson(options.file))
					.repositories
			: options.repositories);
	if (
		!configuredRoots.length ||
		configuredRoots.length > 64 ||
		configuredRoots.some((root) => !path.isAbsolute(root))
	)
		throw new Error("Explicit repository allowlist required");
	const roots = configuredRoots.map((root) => {
		const canonical = fs.realpathSync(root);
		if (!fs.statSync(canonical).isDirectory())
			throw new Error("Invalid repository");
		return { declared: root, canonical };
	});
	if (new Set(roots.map((root) => root.canonical)).size !== roots.length)
		throw new Error("Duplicate repository identity");
	return {
		list({
			repository,
			offset,
			limit,
		}: {
			repository?: string;
			offset: number;
			limit: number;
		}) {
			for (const root of roots)
				if (
					fs.realpathSync(root.declared) !== root.canonical ||
					!fs.lstatSync(root.canonical).isDirectory()
				)
					throw new Error("Repository changed");
			const raw = readConfigurationJson(options.file);
			const manifest =
				options.format === "v2-config"
					? readV2Configuration(
							path.dirname(options.file),
							options.repositories,
						)
					: serverManifestSchema.parse(
							options.format === "manifest"
								? raw
								: importV2CatalogMetadata(raw, configuredRoots),
						);
			// Rereading configuration may not add authority after startup.
			if (
				JSON.stringify(manifest.repositories) !==
				JSON.stringify(configuredRoots)
			)
				throw new Error("Repository allowlist changed");
			const apps = manifest.apps.map((app) => {
				const root = roots.find(
					(root) =>
						root.declared === app.repository ||
						root.canonical === app.repository,
				);
				if (!root) throw new Error("Repository not authorized");
				return { ...app, repository: root.canonical };
			});
			if (
				repository !== undefined &&
				!roots.some((root) => root.canonical === repository)
			)
				throw new Error("Repository not authorized");
			const selected = apps.filter(
				(app) => repository === undefined || app.repository === repository,
			);
			return {
				mode: "inspection-only",
				format: options.format,
				executionAvailable: false,
				runtimeChecked: false,
				validation:
					options.format === "v2-config"
						? "v2-config-native"
						: options.format === "manifest"
							? "manifest-only"
							: "v2-catalog-metadata-only",
				dependencyDeclarations:
					options.format === "v2-config"
						? "configured"
						: options.format === "manifest"
							? "declared-only"
							: "not-imported",
				repositories: roots.map((root) => root.canonical),
				services: manifest.services.map((service) => ({
					id: service.id,
					runtime: service.runtime,
					...(service.binding?.start ? { start: service.binding.start } : {}),
					...(service.binding ? { readiness: service.binding.readiness } : {}),
				})),
				apps: selected.slice(offset, offset + limit),
				total: selected.length,
				nextOffset: offset + limit < selected.length ? offset + limit : null,
			};
		},
	};
}
