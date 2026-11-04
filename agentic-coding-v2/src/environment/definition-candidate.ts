import { type Config, digest } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import {
	type Draft,
	type SourceDraft,
	stored,
} from "./definition-draft-data.ts";
import {
	inspectComposeSource,
	publicComposePath,
} from "./definition-source-check.ts";

const sourceByteLimit = 64 * 1024,
	totalByteLimit = 128 * 1024;
const binding = (repository: string, file: string) =>
	digest(JSON.stringify({ repository, file }));
type Project = ReturnType<typeof validateProjects>[number];
type Entry = {
	app: string;
	target: string;
	status: "parsed" | "missing-source" | "unsupported-target" | "refused";
	bindingDigest?: string;
	sourceDigest?: string;
	compiledDigest?: string;
	serviceCount?: number;
};
function baseIdentity(base: SourceDraft["base"]) {
	if (base === "unobserved") return null;
	if (
		base.version !== 1 ||
		!["absent", "regular"].includes(base.state) ||
		!/^[a-f0-9]{64}$/.test(base.fingerprint) ||
		!Number.isFinite(Date.parse(base.capturedAt)) ||
		base.basis !== "explicit-current-base-not-staging-time" ||
		(base.state === "regular"
			? !/^[a-f0-9]{64}$/.test(base.contentDigest ?? "")
			: base.contentDigest !== undefined)
	)
		throw Error();
	return digest(
		JSON.stringify({
			version: base.version,
			state: base.state,
			fingerprint: base.fingerprint,
			contentDigest: base.contentDigest ?? null,
			capturedAt: base.capturedAt,
			basis: base.basis,
		}),
	);
}
function sourceManifest(source: SourceDraft) {
	if (
		publicComposePath(source.file) !== source.file ||
		Buffer.byteLength(source.content) > sourceByteLimit ||
		Buffer.from(source.content).toString("utf8") !== source.content ||
		digest(source.content) !== source.digest
	)
		throw Error();
	return {
		bindingDigest: binding(source.repository, source.file),
		sourceDigest: source.digest,
		baseDigest: baseIdentity(source.base),
	};
}
function candidateInputs(config: Config, draft: Draft) {
	const projects = validateProjects(config, stored<unknown>(draft.content)),
		sources = draft.sources ?? [],
		targetCount = projects.reduce(
			(count, project) => count + project.targets.length,
			0,
		);
	if (
		digest(draft.content) !== draft.digest ||
		projects.length > 32 ||
		targetCount > 128 ||
		sources.length > 4 ||
		sources.reduce(
			(bytes, source) => bytes + Buffer.byteLength(source.content),
			0,
		) > totalByteLimit
	)
		throw Error();
	const sourceBindings = sources
		.map(sourceManifest)
		.sort((a, b) => a.bindingDigest.localeCompare(b.bindingDigest));
	if (
		new Set(sourceBindings.map((source) => source.bindingDigest)).size !==
		sourceBindings.length
	)
		throw Error();
	const manifest = {
		version: 1,
		definitionDigest: draft.digest,
		repositoryDigest: digest(JSON.stringify(config.repositories)),
		sourceBindings,
	};
	return { projects, sources, manifest };
}
function checkTarget(
	config: Config,
	draft: Draft,
	project: Project,
	target: Project["targets"][number],
	sources: SourceDraft[],
): Entry {
	const row = { app: project.id, target: target.id };
	if (target.runtime !== "compose" || !target.compose)
		return { ...row, status: "unsupported-target" };
	let file: string;
	try {
		file = publicComposePath(target.compose.file);
	} catch {
		return { ...row, status: "refused" };
	}
	const bindingDigest = binding(project.repository, file),
		source = sources.find(
			(source) =>
				source.repository === project.repository && source.file === file,
		);
	if (!source) return { ...row, bindingDigest, status: "missing-source" };
	const checked = inspectComposeSource(
		config,
		draft.content,
		project.id,
		target.id,
		source,
	);
	return {
		...row,
		bindingDigest,
		sourceDigest: source.digest,
		status: checked.accepted ? "parsed" : "refused",
		...(checked.accepted
			? {
					compiledDigest: checked.compiledDigest,
					serviceCount: checked.serviceCount,
				}
			: {}),
	};
}
/** Exact saved-input binding, not a plan, isolated tree or publication grant. */
export function inspectStagedCandidate(config: Config, draft: Draft) {
	const scope = {
		kind: "staged-compose-candidate" as const,
		sourceContentsChecked: false as const,
		runtimeChecked: false as const,
		dependenciesExpanded: false as const,
		isolatedTreeChecked: false as const,
		bindContentsChecked: false as const,
		baseFreshnessChecked: false as const,
		publicationAllowed: false as const,
	};
	try {
		const { projects, sources, manifest } = candidateInputs(config, draft),
			entries = projects.flatMap((project) =>
				project.targets.map((target) =>
					checkTarget(config, draft, project, target, sources),
				),
			),
			used = new Set(
				entries.flatMap((entry) =>
					entry.bindingDigest ? [entry.bindingDigest] : [],
				),
			);
		const orphanBindings = manifest.sourceBindings
				.filter((source) => !used.has(source.bindingDigest))
				.map((source) => source.bindingDigest),
			accepted =
				entries.length > 0 &&
				entries.every((entry) => entry.status === "parsed") &&
				orphanBindings.length === 0;
		return {
			...scope,
			accepted,
			candidateDigest: digest(JSON.stringify(manifest)),
			manifest,
			entries,
			orphanBindings,
			sourceCount: sources.length,
			sourceBytes: sources.reduce(
				(bytes, source) => bytes + Buffer.byteLength(source.content),
				0,
			),
			observedBaseCount: sources.filter(
				(source) => source.base !== "unobserved",
			).length,
			unobservedBaseCount: sources.filter(
				(source) => source.base === "unobserved",
			).length,
			message:
				"Offline saved-input manifest and native Compose-subset coverage only. Unsupported/missing/refused/orphan inputs prevent acceptance. Base observations are bound, NOT refreshed. Parser may inspect containment/bind metadata; no live source bytes or bind contents are read. No isolated tree, runtime validation, review or promotion authority; exact saved-input identity is not readiness.",
		};
	} catch {
		return {
			...scope,
			accepted: false,
			candidateDigest: null,
			manifest: null,
			entries: [],
			orphanBindings: [],
			message:
				"Candidate refused: invalid or oversized saved JSON/source/base data, unsupported/private binding or integrity mismatch. Source text, commands, values, plans and raw errors withheld. No isolated tree, runtime validation or promotion authority.",
		};
	}
}
