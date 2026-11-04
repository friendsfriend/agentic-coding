import fs from "node:fs";
import path from "node:path";
import { type Config, digest } from "../config.ts";
import { contained } from "../git.ts";
import { projectView, validateProjects } from "./catalog.ts";
import type { Action } from "./selection.ts";

/** Observational metadata only. Never compile sources, resolve secrets, issue
 * effects or claim that an immutable historical report is current authority. */
export function inspectDefinition(config: Config, content: string) {
	const scope = {
		repositoryDigest: digest(JSON.stringify(config.repositories)),
		sourceContentsChecked: false,
		runtimeChecked: false,
		dependenciesExpanded: false,
	};
	const entries: {
		app: string;
		action: Action;
		target: string | null;
		runtime?: string;
		status: "observed" | "unresolved" | "not-declared";
		defaultReason: string;
		metadataDigest?: string;
		message: string;
	}[] = [];
	try {
		const projects = validateProjects(config, JSON.parse(content));
		if (
			projects.length > 32 ||
			projects.reduce((count, project) => count + project.targets.length, 0) >
				128 ||
			projects.some((project) =>
				project.targets.some(
					(target) =>
						(target.environment.PATH ?? process.env.PATH ?? "").split(
							path.delimiter,
						).length > 64,
				),
			)
		)
			throw new Error("Preflight scope limit");
		for (const project of projects) {
			if (fs.realpathSync(project.repository) !== project.repository)
				throw new Error("Authorized repository identity changed");
			const view = projectView(project);
			for (const action of ["run", "build", "test"] as const) {
				const choice = view.defaultTargets[action];
				const target = view.targets.find(
					(target) => target.action === action && target.id === choice.id,
				);
				const declared = project.targets.some(
					(target) => target.action === action,
				);
				const row = {
					app: project.id,
					action,
					target: choice.id,
					defaultReason: choice.reason,
				};
				if (!target) {
					entries.push({
						...row,
						status: declared ? "unresolved" : "not-declared",
						message: declared
							? "No eligible unambiguous implicit default. Explicit target/profile/runtime selection may be required; no source checks performed."
							: "Action has no declared targets; no executable validation coverage.",
					});
					continue;
				}
				try {
					const observations: unknown[] = [];
					const observe = (requested: string, directory: boolean) => {
						const selected = contained(project.repository, requested),
							stat = fs.statSync(selected);
						if (
							directory
								? !stat.isDirectory()
								: !stat.isFile() || stat.size > 65536
						)
							throw new Error("Unsupported source metadata");
						observations.push({
							path: requested,
							dev: stat.dev,
							ino: stat.ino,
							size: stat.size,
							mtime: stat.mtimeMs,
							ctime: stat.ctimeMs,
						});
					};
					observe(target.cwd, true);
					if (target.compose) observe(target.compose.file, false);
					// Container build context/Dockerfile and arbitrary command source trees are
					// intentionally NOT inferred. Existing execution adapters remain separate.
					entries.push({
						...row,
						runtime: target.runtime,
						status: "observed",
						metadataDigest: digest(JSON.stringify({ target, observations })),
						message: `Default selection, availability metadata and contained cwd${target.compose ? "/Compose-file metadata" : ""} observed only. No source contents compiled/read, build-context validation, secrets, daemon/cluster connectivity, dependency expansion or runtime execution.`,
					});
				} catch {
					entries.push({
						...row,
						runtime: target.runtime,
						status: "unresolved",
						message:
							"Contained cwd/source metadata check failed (including missing, escaping or unsupported source). Values and filesystem errors withheld.",
					});
				}
			}
		}
		return {
			...scope,
			completed: true,
			schemaAccepted: true,
			entries,
			message:
				"Read-only default/path metadata preflight. All results are historical observations, never readiness, runtime validation, review approval or promotion eligibility.",
		};
	} catch {
		return {
			...scope,
			completed: false,
			schemaAccepted: null,
			entries: [],
			message:
				"Preflight refused: invalid JSON/schema, changed repository identity or scope above 32 projects / 128 targets / 64 PATH entries. Input values and parser/filesystem errors withheld.",
		};
	}
}
