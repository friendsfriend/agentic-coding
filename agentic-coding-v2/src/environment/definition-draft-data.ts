import { type Config, digest, text } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import { publicComposePath } from "./definition-source-check.ts";

export type SourceDraft = {
	repository: string;
	file: string;
	content: string;
	digest: string;
	base: "unobserved";
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
		sources = (previous.sources ?? []).filter(
			(source) =>
				source.repository !== binding.repository ||
				source.file !== binding.file,
		);
	sources.push({
		...binding,
		content,
		digest: digest(content),
		base: "unobserved",
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
