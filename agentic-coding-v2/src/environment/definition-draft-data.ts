import { type Config, digest, text } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import type { SourceBase } from "./definition-source-base.ts";
import { publicComposePath } from "./definition-source-check.ts";
import type { StagedTreeIdentity } from "./definition-staged-tree.ts";

export type SourceDraft = {
	repository: string;
	file: string;
	/** An extra file the staged stack needs, bound to an already-staged target. */
	auxiliary?: boolean;
	content: string;
	digest: string;
	base: "unobserved" | SourceBase;
};
export type Base = {
	destination: string;
	directoryDigest?: string;
	state: "absent" | "regular";
	digest?: string;
};
export type Draft = {
	id: string;
	revision: number;
	content: string;
	digest: string;
	base: Base;
	sources?: SourceDraft[];
	/** Native task that staged this draft; absent for developer-staged drafts. */
	stagedBy?: number | null;
};
export type Receipt = {
	request: string;
	result: { id: string; revision: number; digest: string };
};
/** Digest-only record of one verified staged tree for an exact draft revision.
 * No path, source text or tree directory is retained. */
export type StagedTreeReceipt = {
	draftId: string;
	revision: number;
	digest: string;
	candidateDigest: string;
	treeDigest: string;
	fileCount: number;
	bytes: number;
	observedAt: string;
	retained?: { name: string; retainedAt: string };
	releasedAt?: string;
	releaseAuthority?: string;
	authority: string;
};
export type DraftData = {
	drafts: Record<string, string>;
	receipts: Record<string, string>;
	trees?: Record<string, string>;
	treeCleanups?: Record<string, string>;
	treeCleanupAcknowledgements?: Record<string, string>;
};
export function stored<T>(value: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(
			"Private draft state is malformed; contents and parser errors are withheld",
		);
	}
}
/** Stable private saved-source identity, independent of JSON target selection. */
export const sourceBindingDigest = (repository: string, file: string) =>
	digest(JSON.stringify({ repository, file }));
/** A bounded relative public path: no dotfiles, traversal, absolute paths or
 * deep trees, so an auxiliary file cannot become a private-config back door. */
export function auxiliaryPath(raw: unknown) {
	const value = text(raw, "auxiliary source path", 200),
		parts = value.split("/");
	if (
		parts.length < 1 ||
		parts.length > 3 ||
		parts.some(
			(part) =>
				!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(part) || part === "..",
		)
	)
		throw new Error(
			"Auxiliary sources require a bounded relative public path with no dotfiles",
		);
	return value;
}
export function sourceBinding(
	config: Config,
	content: string,
	app: string,
	target: string,
) {
	try {
		const project = validateProjects(config, JSON.parse(content)).find(
			(project) => project.id === app,
		);
		const definition = project?.targets.find(
			(candidate) => candidate.id === target,
		)?.compose;
		if (!project || !definition) throw Error();
		return {
			repository: project.repository,
			file: publicComposePath(definition.file),
		};
	} catch {
		throw new Error(
			"Valid saved JSON and an exact conventional public Compose target are required; values withheld",
		);
	}
}
/** Caller supplies a native transaction document after checking private storage.
 * This edit transition performs no repository reads/writes or runtime effects. */
export function stageSource(
	config: Config,
	doc: DraftData,
	body: Record<string, unknown>,
) {
	if (
		Object.keys(body).some(
			(key) =>
				![
					"requestId",
					"id",
					"revision",
					"app",
					"target",
					"content",
					"auxiliary",
					"file",
				].includes(key),
		)
	)
		throw new Error("Unsupported staged source field");
	const requestId = text(body.requestId, "source request ID", 128),
		id = text(body.id, "draft ID", 80),
		app = text(body.app, "source app", 128),
		target = text(body.target, "source target", 128),
		content = body.content;
	if (!/^draft-[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid definition draft ID");
	if (
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1 ||
		typeof content !== "string" ||
		Buffer.byteLength(content) > 65536 ||
		Buffer.from(content).toString("utf8") !== content
	)
		throw new Error(
			"Exact current revision and UTF8 source text of at most 64 KiB required",
		);
	const auxiliary = body.auxiliary === true;
	if (body.auxiliary !== undefined && typeof body.auxiliary !== "boolean")
		throw new Error("Auxiliary source selection must be a boolean");
	const auxiliaryFile = auxiliary ? auxiliaryPath(body.file) : undefined;
	if (!auxiliary && body.file !== undefined)
		throw new Error(
			"An explicit source file is only accepted for an auxiliary source",
		);
	const request = digest(
			JSON.stringify({
				kind: "staged-compose-source",
				id,
				revision: body.revision,
				app,
				target,
				content,
				auxiliary,
				file: auxiliaryFile ?? null,
			}),
		),
		key = digest(requestId),
		recorded = doc.receipts[key];
	if (recorded) {
		const receipt = stored<Receipt>(recorded);
		if (receipt.request !== request)
			throw new Error("Source request ID reused for different input");
		return receipt.result;
	}
	if (Object.keys(doc.receipts).length >= 256)
		throw new Error("Native draft receipt capacity reached");
	const raw = doc.drafts[id];
	if (!raw) throw new Error("Unknown definition draft");
	const previous = stored<Draft>(raw);
	if (previous.revision !== body.revision)
		throw new Error(
			"Draft revision conflict; load current before saving source",
		);
	const declared = sourceBinding(config, previous.content, app, target);
	if (auxiliaryFile === declared.file)
		throw new Error(
			"An auxiliary source cannot replace the target's declared Compose file",
		);
	// An auxiliary file belongs to a target that is already staged: it never
	// invents a target, and it never displaces the declared Compose file.
	if (
		auxiliaryFile &&
		!previous.sources?.some(
			(source) =>
				!source.auxiliary &&
				source.repository === declared.repository &&
				source.file === declared.file,
		)
	)
		throw new Error(
			"Stage the target's declared Compose file before staging an auxiliary source",
		);
	if (auxiliaryFile) {
		const projects = validateProjects(config, JSON.parse(previous.content));
		if (
			projects.some(
				(project) =>
					project.repository === declared.repository &&
					project.targets.some((candidate) => {
						const file = candidate.compose?.file;
						return (
							file !== undefined &&
							(file === auxiliaryFile ||
								file.startsWith(`${auxiliaryFile}/`) ||
								auxiliaryFile.startsWith(`${file}/`))
						);
					}),
			)
		)
			throw new Error(
				"An auxiliary source cannot replace any declared Compose target file",
			);
	}
	const binding = auxiliaryFile
			? { repository: declared.repository, file: auxiliaryFile }
			: declared,
		original = previous.sources?.find(
			(source) =>
				source.repository === binding.repository &&
				source.file === binding.file,
		),
		sources = (previous.sources ?? []).filter(
			(source) =>
				source.repository !== binding.repository ||
				source.file !== binding.file,
		);
	if (original && Boolean(original.auxiliary) !== Boolean(auxiliaryFile))
		throw new Error(
			"A staged source binding cannot change between auxiliary and Compose roles; remove it explicitly first",
		);
	if (
		sources.some(
			(source) =>
				source.repository === binding.repository &&
				(source.file.startsWith(`${binding.file}/`) ||
					binding.file.startsWith(`${source.file}/`)),
		)
	)
		throw new Error("Staged source file/directory paths must not overlap");
	sources.push({
		...binding,
		content,
		digest: digest(content),
		base: original?.base ?? "unobserved",
		...(auxiliaryFile ? { auxiliary: true as const } : {}),
	});
	if (
		sources.length > 4 ||
		sources.reduce(
			(size, source) => size + Buffer.byteLength(source.content),
			0,
		) > 131072
	)
		throw new Error(
			"Staged source capacity exceeded (4 files / 128 KiB per draft)",
		);
	const draft = { ...previous, revision: previous.revision + 1, sources },
		result = { id, revision: draft.revision, digest: draft.digest };
	doc.drafts[id] = JSON.stringify(draft);
	doc.receipts[key] = JSON.stringify({ request, result });
	return result;
}

/** Explicit late-base establishment; the native caller owns the transaction and
 * supplies the bounded read adapter. Existing bases cannot be overwritten. */
export function captureSourceBase(
	config: Config,
	doc: DraftData,
	body: Record<string, unknown>,
	observe: (repository: string, file: string) => SourceBase,
) {
	if (
		Object.keys(body).some(
			(key) =>
				![
					"requestId",
					"id",
					"revision",
					"app",
					"target",
					"sourceDigest",
					"readBase",
					"acceptCurrentBase",
				].includes(key),
		) ||
		body.readBase !== true ||
		body.acceptCurrentBase !== true
	)
		throw new Error(
			"Explicit source-base read and current-not-staging-time base acceptance required; unknown fields refused",
		);
	const id = text(body.id, "draft ID", 80),
		app = text(body.app, "source app", 128),
		target = text(body.target, "source target", 128),
		sourceDigest = text(body.sourceDigest, "source digest", 64),
		requestId = text(body.requestId, "base request ID", 128);
	if (
		!/^draft-[a-f0-9]{64}$/.test(id) ||
		!/^[a-f0-9]{64}$/.test(sourceDigest) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Exact current revision and source digest required");
	const request = digest(
			JSON.stringify({
				kind: "establish-source-base",
				id,
				revision: body.revision,
				app,
				target,
				sourceDigest,
				readBase: true,
				acceptCurrentBase: true,
			}),
		),
		key = digest(requestId),
		recorded = doc.receipts[key];
	if (recorded) {
		const receipt = stored<Receipt>(recorded);
		if (receipt.request !== request)
			throw new Error("Base request ID reused for different input");
		return receipt.result;
	}
	if (Object.keys(doc.receipts).length >= 256)
		throw new Error("Native draft receipt capacity reached");
	const raw = doc.drafts[id];
	if (!raw) throw new Error("Unknown definition draft");
	const previous = stored<Draft>(raw);
	if (previous.revision !== body.revision)
		throw new Error(
			"Draft revision conflict; load current before establishing base",
		);
	const binding = sourceBinding(config, previous.content, app, target),
		source = previous.sources?.find(
			(source) =>
				source.repository === binding.repository &&
				source.file === binding.file,
		);
	if (
		!source ||
		source.digest !== sourceDigest ||
		digest(source.content) !== sourceDigest
	)
		throw new Error("No exact matching staged source");
	if (source.base !== "unobserved")
		throw new Error("Source base already established; rebasing is unsupported");
	const base = observe(binding.repository, binding.file),
		sources = previous.sources?.map((candidate) =>
			candidate === source ? { ...candidate, base } : candidate,
		),
		draft = { ...previous, revision: previous.revision + 1, sources },
		result = { id, revision: draft.revision, digest: draft.digest };
	doc.drafts[id] = JSON.stringify(draft);
	doc.receipts[key] = JSON.stringify({ request, result });
	return result;
}

/** Exact-input receipt lookup shared by private draft edit transitions. */
function recordedReceipt(
	doc: DraftData,
	key: string,
	request: string,
): Receipt["result"] | null {
	const recorded = doc.receipts[key];
	if (recorded) {
		const receipt = stored<Receipt>(recorded);
		if (receipt.request !== request)
			throw new Error("Draft request ID reused for different input");
		return receipt.result;
	}
	if (Object.keys(doc.receipts).length >= 256)
		throw new Error("Native draft receipt capacity reached");
	return null;
}
function currentDraft(doc: DraftData, id: string, revision: number) {
	const raw = doc.drafts[id];
	if (!raw) throw new Error("Unknown definition draft");
	const draft = stored<Draft>(raw);
	if (draft.revision !== revision)
		throw new Error("Draft revision conflict; load current before editing");
	return draft;
}
/** Removes one saved binding, selected by exact target or binding digest. Repository
 * files, live configuration and historical reports are never touched. */
export function removeSource(
	config: Config,
	doc: DraftData,
	body: Record<string, unknown>,
) {
	if (
		Object.keys(body).some(
			(key) =>
				![
					"requestId",
					"id",
					"revision",
					"app",
					"target",
					"bindingDigest",
				].includes(key),
		)
	)
		throw new Error("Unsupported staged source removal field");
	const id = text(body.id, "draft ID", 80),
		requestId = text(body.requestId, "draft request ID", 128);
	if (
		!/^draft-[a-f0-9]{64}$/.test(id) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Exact current revision required");
	const byDigest = body.bindingDigest !== undefined;
	if (byDigest && (body.app !== undefined || body.target !== undefined))
		throw new Error("Choose a binding digest or app/target, not both");
	const selection = byDigest
		? { bindingDigest: text(body.bindingDigest, "source binding digest", 64) }
		: {
				app: text(body.app, "source app", 128),
				target: text(body.target, "source target", 128),
			};
	if (
		selection.bindingDigest &&
		!/^[a-f0-9]{64}$/.test(selection.bindingDigest)
	)
		throw new Error("Invalid saved source binding digest");
	const request = digest(
			JSON.stringify({
				kind: "remove-staged-source",
				id,
				revision: body.revision,
				...selection,
			}),
		),
		key = digest(requestId),
		receipt = recordedReceipt(doc, key, request);
	if (receipt) return receipt;
	const previous = currentDraft(doc, id, Number(body.revision)),
		binding = selection.bindingDigest
			? null
			: sourceBinding(
					config,
					previous.content,
					text(selection.app, "source app", 128),
					text(selection.target, "source target", 128),
				),
		selectedDigest =
			selection.bindingDigest ??
			(binding && sourceBindingDigest(binding.repository, binding.file)),
		sources = (previous.sources ?? []).filter(
			(source) =>
				sourceBindingDigest(source.repository, source.file) !== selectedDigest,
		);
	if (sources.length === (previous.sources ?? []).length)
		throw new Error("No staged source matches this exact target binding");
	const draft = { ...previous, revision: previous.revision + 1, sources },
		result = { id, revision: draft.revision, digest: draft.digest };
	doc.drafts[id] = JSON.stringify(draft);
	doc.receipts[key] = JSON.stringify({ request, result });
	return result;
}
/** Deletes only the private staged draft document. Immutable preflight reports
 * and exact-input receipts remain historical data, not restored authority. */
export function removeDraft(doc: DraftData, body: Record<string, unknown>) {
	if (
		Object.keys(body).some(
			(key) => !["requestId", "id", "revision"].includes(key),
		)
	)
		throw new Error("Unsupported staged draft removal field");
	const id = text(body.id, "draft ID", 80),
		requestId = text(body.requestId, "draft request ID", 128);
	if (
		!/^draft-[a-f0-9]{64}$/.test(id) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Exact current revision required");
	const request = digest(
			JSON.stringify({
				kind: "remove-staged-draft",
				id,
				revision: body.revision,
			}),
		),
		key = digest(requestId),
		receipt = recordedReceipt(doc, key, request);
	if (receipt) return receipt;
	currentDraft(doc, id, Number(body.revision));
	delete doc.drafts[id];
	// A removed draft no longer owns a retention record or its directory.
	delete doc.trees?.[id];
	const result = { id, removed: true as const };
	doc.receipts[key] = JSON.stringify({ request, result });
	return result;
}

/** Durably record the identity of a tree verified for this exact draft revision.
 * Digest-only history: the next edit makes it stale rather than adoptable. */
export function recordStagedTree(
	doc: DraftData,
	draft: Draft,
	identity: StagedTreeIdentity,
	candidateDigest: string,
	retained?: { name: string },
) {
	if (Object.keys(doc.trees ?? {}).length >= 64 && !doc.trees?.[draft.id])
		throw new Error(
			"Private staged-tree record capacity reached; automatic pruning is unsupported",
		);
	doc.trees ??= {};
	doc.trees[draft.id] = JSON.stringify({
		draftId: draft.id,
		revision: draft.revision,
		digest: draft.digest,
		candidateDigest,
		treeDigest: identity.treeDigest,
		fileCount: identity.fileCount,
		bytes: identity.bytes,
		observedAt: new Date().toISOString(),
		...(retained
			? {
					retained: {
						name: retained.name,
						retainedAt: new Date().toISOString(),
					},
				}
			: {}),
		authority:
			"A recorded tree identity for one draft revision: digest-only, plus the name of a retained private tree when one was kept. It proves neither current source content, runtime readiness, review approval nor publication authority, and the retained directory is inspectable history, not an execution or publication input.",
	} satisfies StagedTreeReceipt);
	return draft.id;
}
/** Explicit digest-addressed release: the caller performs the filesystem step. */
export function releaseTreeRequest(body: Record<string, unknown>) {
	if (Object.keys(body).some((key) => !["requestId", "name"].includes(key)))
		throw new Error("Unsupported retained-tree release field");
	const name = text(body.name, "retained tree digest", 64),
		requestId = text(body.requestId, "release request ID", 128);
	if (!/^[a-f0-9]{64}$/.test(name))
		throw new Error(
			"Retained tree release is addressed by the recorded tree digest",
		);
	const request = digest(
		JSON.stringify({ kind: "release-retained-tree", name }),
	);
	return { name, request, key: digest(requestId) };
}
/** Drop one retention claim by its exact digest; no other record is touched. */
export function clearRetainedTree(doc: DraftData, name: string) {
	for (const [id, raw] of Object.entries(doc.trees ?? {})) {
		const receipt = stored<StagedTreeReceipt>(raw);
		if (receipt.retained?.name !== name) continue;
		const { retained: _released, ...rest } = receipt;
		doc.trees ??= {};
		doc.trees[id] = JSON.stringify({
			...rest,
			releasedAt: new Date().toISOString(),
			releaseAuthority:
				"The retained directory was released explicitly by its own recorded digest; the identity of the tree that was verified remains recorded.",
		} satisfies StagedTreeReceipt);
		return { draftId: id, revision: receipt.revision };
	}
	return null;
}
export function stagedTreeReceipt(doc: DraftData, id: string) {
	const raw = doc.trees?.[id];
	return raw ? stored<StagedTreeReceipt>(raw) : null;
}
