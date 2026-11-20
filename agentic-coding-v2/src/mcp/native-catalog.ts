import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { projectView, validateProjects } from "../environment/catalog.ts";
import { readEnvironmentDefinitions } from "../environment/definition-file.ts";
import {
	definitionProjectLimit,
	definitionTargetLimit,
} from "../environment/definition-limits.ts";
import { discoverDefinitions } from "../environment/discovery.ts";
import { CatalogRefusal, type EnvironmentCatalog } from "./catalog.ts";

/** Reuses domain rules only. No Harness, Runtime, ModelRuntime or state store is opened. */
export function createNativeCatalog(options: {
	configDir: string;
	repositories: readonly string[];
}): EnvironmentCatalog {
	const repositories = [
		...new Set(
			options.repositories.map((repository) => fs.realpathSync(repository)),
		),
	];
	if (
		!repositories.length ||
		repositories.length > definitionProjectLimit ||
		repositories.some(
			(repository) =>
				repository.length > 4096 || !fs.statSync(repository).isDirectory(),
		)
	)
		throw new Error(
			`Supply 1–${definitionProjectLimit} existing repository directories`,
		);
	const config: Config = {
		configDir: path.resolve(options.configDir),
		repositories,
		// These fields are unused by the reused inspection functions. Do not load
		// agent configuration simply to satisfy the legacy Config type.
		stateDir: "",
		profiles: [],
		orchestratorProfile: "",
		providers: [],
		skills: [],
	};
	function authorize(repository: string) {
		if (!repositories.includes(repository))
			throw new CatalogRefusal("repository-not-authorized");
		// Recheck the root: a replaced symlink must not widen the allowlist.
		if (
			fs.realpathSync(repository) !== repository ||
			!fs.lstatSync(repository).isDirectory()
		)
			throw new CatalogRefusal("repository-not-authorized");
	}
	return {
		list({ repository, offset, limit }) {
			try {
				if (repository !== undefined) authorize(repository);
				const projects = validateProjects(
					config,
					readEnvironmentDefinitions(config.configDir),
				);
				if (
					projects.length > definitionProjectLimit ||
					projects.reduce(
						(count, project) => count + project.targets.length,
						0,
					) > definitionTargetLimit
				)
					throw new CatalogRefusal("catalog-unavailable");
				for (const project of projects) authorize(project.repository);
				const selected = projects.filter(
					(project) =>
						repository === undefined || project.repository === repository,
				);
				return {
					mode: "inspection-only",
					executionAvailable: false,
					runtimeChecked: false,
					repositories,
					projects: selected.slice(offset, offset + limit).map((project) => {
						const view = projectView(project);
						return {
							id: view.id,
							kind: view.kind,
							repository: view.repository,
							defaultTargets: view.defaultTargets,
							targets: view.targets.map((target) => ({
								id: target.id,
								action: target.action,
								runtime: target.runtime,
								profile: target.profile ?? "default",
								...(target.label ? { label: target.label } : {}),
								availability: target.availability,
							})),
						};
					}),
					total: selected.length,
					nextOffset: offset + limit < selected.length ? offset + limit : null,
				};
			} catch (error) {
				if (error instanceof CatalogRefusal) throw error;
				throw new CatalogRefusal("catalog-unavailable");
			}
		},
		discover({ repository, directory }) {
			try {
				authorize(repository);
				return {
					mode: "inspection-only",
					executionAvailable: false,
					...discoverDefinitions(config, repository, undefined, directory),
				};
			} catch (error) {
				if (error instanceof CatalogRefusal) throw error;
				throw new CatalogRefusal("discovery-unavailable");
			}
		},
	};
}
