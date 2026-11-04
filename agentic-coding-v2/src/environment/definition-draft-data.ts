import { type Config, digest, text } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import type { SourceBase } from "./definition-source-base.ts";
import { publicComposePath } from "./definition-source-check.ts";

export type SourceDraft = {
	repository: string;
	file: string;
	content: string;
	digest: string;
	base: "unobserved" | SourceBase;
};
export type Base = {
	destination: string;
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
};
export type Receipt = {
	request: string;
	result: { id: string; revision: number; digest: string };
};
export type DraftData = {
	drafts: Record<string, string>;
	receipts: Record<string, string>;
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
				!["requestId", "id", "revision", "app", "target", "content"].includes(
					key,
				),
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
	const request = digest(
			JSON.stringify({
				kind: "staged-compose-source",
				id,
				revision: body.revision,
				app,
				target,
				content,
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
	const binding = sourceBinding(config, previous.content, app, target),
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
	sources.push({
		...binding,
		content,
		digest: digest(content),
		base: original?.base ?? "unobserved",
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
/** Removes one staged source bound to the exact current target. Repository
 * files, live configuration and historical reports are never touched. */
export function removeSource(
	config: Config,
	doc: DraftData,
	body: Record<string, unknown>,
) {
	if (
		Object.keys(body).some(
			(key) => !["requestId", "id", "revision", "app", "target"].includes(key),
		)
	)
		throw new Error("Unsupported staged source removal field");
	const id = text(body.id, "draft ID", 80),
		app = text(body.app, "source app", 128),
		target = text(body.target, "source target", 128),
		requestId = text(body.requestId, "draft request ID", 128);
	if (
		!/^draft-[a-f0-9]{64}$/.test(id) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Exact current revision required");
	const request = digest(
			JSON.stringify({
				kind: "remove-staged-source",
				id,
				revision: body.revision,
				app,
				target,
			}),
		),
		key = digest(requestId),
		receipt = recordedReceipt(doc, key, request);
	if (receipt) return receipt;
	const previous = currentDraft(doc, id, Number(body.revision)),
		binding = sourceBinding(config, previous.content, app, target),
		sources = (previous.sources ?? []).filter(
			(source) =>
				source.repository !== binding.repository ||
				source.file !== binding.file,
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
	const result = { id, removed: true as const };
	doc.receipts[key] = JSON.stringify({ request, result });
	return result;
}
