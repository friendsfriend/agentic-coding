import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import { validateProjects } from "./catalog.ts";
import { inspectStagedCandidate } from "./definition-candidate.ts";
import {
	type Base,
	captureSourceBase,
	type Draft,
	type Receipt,
	removeDraft,
	removeSource,
	type SourceDraft,
	sourceBinding,
	sourceBindingDigest,
	stageSource,
	stored,
} from "./definition-draft-data.ts";
import { inspectDefinition } from "./definition-preflight.ts";
import { preflightRequest } from "./definition-preflight-request.ts";
import { inspectDestination } from "./definition-promotion.ts";
import {
	Promotions,
	promotionIndex,
	promotionRequest,
	readPromotion,
	recordPromotion,
	replayPromotion,
} from "./definition-promotion-records.ts";
import {
	inspectSourceBase,
	observeSourceBase,
} from "./definition-source-base.ts";
import { inspectComposeSource } from "./definition-source-check.ts";
import { assembleStagedTree } from "./definition-staged-tree.ts";
import { within } from "./path-within.ts";

const DraftState = defineDoc<{
	drafts: Record<string, string>;
	receipts: Record<string, string>;
}>({
	kind: "v2.environment-drafts",
	version: 1,
	scope: "session",
	initial: () => ({ drafts: {}, receipts: {} }),
	checkpointWhen: () => true,
});
const Preflights = defineDoc<{
	reports: Record<string, string>;
	requests: Record<string, string>;
}>({
	kind: "v2.environment-definition-preflights",
	version: 1,
	scope: "session",
	initial: () => ({ reports: {}, requests: {} }),
	checkpointWhen: () => true,
});
type Preflight = (
	| ReturnType<typeof inspectDefinition>
	| ReturnType<typeof inspectComposeSource>
	| ReturnType<typeof inspectSourceBase>
	| ReturnType<typeof inspectStagedCandidate>
	| ReturnType<typeof assembleStagedTree>
) & {
	id: string;
	draftId: string;
	revision: number;
	digest: string;
	observedAt: string;
	ordinal: number;
	historical: true;
	authority: string;
};
const parseDraft = (value: string) => stored<Draft>(value);

/** Recorded live destination base; shared no-follow read, never a write. */
function base(config: Config): Base {
	const live = inspectDestination(config);
	return {
		destination: live.destination,
		directoryDigest: live.directoryDigest,
		state: live.state,
		...(live.digest ? { digest: live.digest } : {}),
	};
}
function privateState(config: Config) {
	const root = fs.realpathSync(config.stateDir),
		stat = fs.statSync(root);
	let native = root;
	try {
		native = fs.realpathSync(path.join(root, "native"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Native draft storage is unavailable");
	}
	if (
		!stat.isDirectory() ||
		(stat.mode & 0o077) !== 0 ||
		!within(root, native) ||
		config.repositories.some(
			(repo) => within(repo, root) || within(repo, native),
		)
	)
		throw new Error(
			"Drafts require a private native state directory outside every authorized repository",
		);
}
function schema(config: Config, draft: Draft) {
	const binding = {
		contentDigest: draft.digest,
		repositoryDigest: digest(JSON.stringify(config.repositories)),
		scope: "schema-only",
	};
	try {
		validateProjects(config, JSON.parse(draft.content));
		return {
			...binding,
			valid: true,
			message:
				"Native v1 schema accepted. Referenced files, sources, defaults/availability and runtime effects have NOT been validated. No execution or promotion authority.",
		};
	} catch {
		return {
			...binding,
			valid: false,
			message:
				"JSON/native v1 schema rejected. Check fields, target/dependency constraints and exact authorized repository paths. Values and parser errors are withheld.",
		};
	}
}
/** Private native documents are staged data, never reviews, runnable targets or
 * restored execution authority. No content is included in environment snapshots. */
export class DefinitionDrafts {
	constructor(
		private config: Config,
		private engine: () => Harness,
	) {}
	async list() {
		privateState(this.config);
		const doc = await this.engine().snapshot(DraftState, background);
		return Object.values(doc?.drafts ?? {}).map((value) => {
			const { id, revision, digest } = parseDraft(value);
			return { id, revision, digest };
		});
	}
	async read(id: string) {
		privateState(this.config);
		this.id(id);
		const doc = await this.engine().snapshot(DraftState, background),
			raw = doc?.drafts[id];
		if (!raw) throw new Error("Unknown definition draft");
		const draft = parseDraft(raw);
		let destination: unknown = null;
		let destinationError = false;
		try {
			destination = inspectDestination(this.config);
		} catch {
			destinationError = true;
		}
		const reports = await this.engine().snapshot(Preflights, background);
		const preflightReports = Object.values(reports?.reports ?? {})
			.map((value) => stored<Preflight>(value))
			.filter((report) => report.draftId === id)
			.map(({ id, revision, digest, observedAt, ordinal }) => ({
				id,
				revision,
				digest,
				observedAt,
				ordinal,
			}))
			.sort((a, b) => a.ordinal - b.ordinal);
		let baseMatches: boolean | null = null;
		try {
			baseMatches =
				JSON.stringify(draft.base) === JSON.stringify(base(this.config));
		} catch {
			/* Unavailable is not unchanged. */
		}
		return {
			...draft,
			preflightReports,
			sourceBindings: (draft.sources ?? []).map(({ repository, file }) => ({
				bindingDigest: sourceBindingDigest(repository, file),
				repository,
				file,
			})),
			schema: schema(this.config, draft),
			baseMatches,
			destination: destinationError
				? { state: "unavailable" as const, digest: null }
				: {
						state: (destination as ReturnType<typeof inspectDestination>).state,
						digest: (destination as ReturnType<typeof inspectDestination>)
							.digest,
					},
			authority:
				"Staged text only. Base comparison is an observation, never a promotion fence. No runtime validation, approval or promotion.",
		};
	}
	async report(id: string) {
		privateState(this.config);
		if (!/^preflight-[a-f0-9]{64}$/.test(id))
			throw new Error("Invalid preflight ID");
		const doc = await this.engine().snapshot(Preflights, background),
			raw = doc?.reports[id];
		if (!raw) throw new Error("Unknown definition preflight");
		return stored<Preflight>(raw);
	}
	async preflight(body: Record<string, unknown>) {
		privateState(this.config);
		const {
			id,
			contentDigest,
			candidate,
			tree,
			compareBase,
			stagedSource,
			selection,
			request,
			key,
		} = preflightRequest(body);
		return this.engine().commit(async (tx) => {
			const reports = await tx.doc(Preflights),
				recorded = reports.requests[key];
			if (recorded) {
				const receipt = stored<{ request: string; id: string }>(recorded);
				if (receipt.request !== request)
					throw new Error("Preflight request ID reused for different input");
				const raw = reports.reports[receipt.id];
				if (!raw) throw new Error("Private preflight receipt is unavailable");
				return stored<Preflight>(raw);
			}
			if (Object.keys(reports.reports).length >= 64)
				throw new Error(
					"Private preflight capacity reached; automatic pruning is unsupported",
				);
			const drafts = await tx.doc(DraftState),
				raw = drafts.drafts[id];
			if (!raw) throw new Error("Unknown definition draft");
			const draft = parseDraft(raw);
			if (draft.revision !== body.revision || draft.digest !== contentDigest)
				throw new Error("Draft changed; load current before preflight");
			let staged: SourceDraft | undefined;
			if ((stagedSource || compareBase) && selection) {
				const binding = sourceBinding(
					this.config,
					draft.content,
					selection.app,
					selection.target,
				);
				staged = draft.sources?.find(
					(source) =>
						source.repository === binding.repository &&
						source.file === binding.file,
				);
				if (!staged)
					throw new Error(
						"No saved source matches this exact current target binding",
					);
			}
			const comparison =
				compareBase && selection && staged && staged.base !== "unobserved"
					? inspectSourceBase(
							{ ...staged, base: staged.base },
							selection.app,
							selection.target,
						)
					: null;
			if (compareBase && !comparison)
				throw new Error(
					"No established source base; explicit capture/acceptance required",
				);
			const report: Preflight = {
				...(candidate
					? inspectStagedCandidate(this.config, draft)
					: tree
						? assembleStagedTree(this.config, draft)
						: (comparison ??
							(selection
								? inspectComposeSource(
										this.config,
										draft.content,
										selection.app,
										selection.target,
										staged,
									)
								: inspectDefinition(this.config, draft.content)))),
				id: `preflight-${key}`,
				draftId: id,
				revision: draft.revision,
				digest: contentDigest,
				observedAt: new Date().toISOString(),
				ordinal: Object.keys(reports.reports).length + 1,
				historical: true,
				authority:
					"Historical preflight data only. No saved report restores source identity, readiness, execution, review approval or promotion authority; sources may already have changed.",
			};
			reports.reports[report.id] = JSON.stringify(report);
			reports.requests[key] = JSON.stringify({ request, id: report.id });
			return report;
		}, background);
	}
	async captureBase(body: Record<string, unknown>) {
		privateState(this.config);
		return this.engine().commit(
			async (tx) =>
				captureSourceBase(
					this.config,
					await tx.doc(DraftState),
					body,
					observeSourceBase,
				),
			background,
		);
	}
	async saveSource(body: Record<string, unknown>) {
		privateState(this.config);
		return this.engine().commit(
			async (tx) => stageSource(this.config, await tx.doc(DraftState), body),
			background,
		);
	}
	/** Explicit private cleanup only: no repository, live-config or report change. */
	async removeSource(body: Record<string, unknown>) {
		privateState(this.config);
		return this.engine().commit(
			async (tx) => removeSource(this.config, await tx.doc(DraftState), body),
			background,
		);
	}
	async removeDraft(body: Record<string, unknown>) {
		privateState(this.config);
		return this.engine().commit(
			async (tx) => removeDraft(await tx.doc(DraftState), body),
			background,
		);
	}
	/** Historical reads remain behind the same private-state/authenticated boundary. */
	async promotions() {
		privateState(this.config);
		return promotionIndex(await this.engine().snapshot(Promotions, background));
	}
	async promotion(id: string) {
		privateState(this.config);
		return readPromotion(
			await this.engine().snapshot(Promotions, background),
			id,
		);
	}
	async promote(body: Record<string, unknown>) {
		privateState(this.config);
		const intent = promotionRequest(body);
		return this.engine().commit(async (tx) => {
			const records = await tx.doc(Promotions),
				replay = replayPromotion(records, intent);
			if (replay) return replay;
			return recordPromotion(
				this.config,
				records,
				await tx.doc(DraftState),
				intent,
			);
		}, background);
	}
	private id(value: string) {
		if (!/^draft-[a-f0-9]{64}$/.test(value))
			throw new Error("Invalid definition draft ID");
	}
	async save(body: Record<string, unknown>) {
		privateState(this.config);
		if (
			Object.keys(body).some(
				(key) => !["requestId", "content", "id", "revision"].includes(key),
			)
		)
			throw new Error("Unsupported draft field");
		const requestId = text(body.requestId, "draft request ID", 128),
			content = text(body.content, "draft content", 65536);
		if (Buffer.byteLength(content) > 65536)
			throw new Error("Draft content exceeds 64 KiB");
		const editing = body.id !== undefined;
		const id = editing
			? text(body.id, "draft ID", 80)
			: `draft-${digest(requestId)}`;
		this.id(id);
		if (
			editing
				? !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
				: body.revision !== undefined
		)
			throw new Error(
				"Saving an existing draft requires its exact positive revision; creation must omit it",
			);
		const request = digest(
				JSON.stringify({ id, revision: body.revision ?? null, content }),
			),
			key = digest(requestId);
		return this.engine().commit(async (tx) => {
			const doc = await tx.doc(DraftState),
				recorded = doc.receipts[key];
			if (recorded) {
				const receipt = stored<Receipt>(recorded);
				if (receipt.request !== request)
					throw new Error(
						"Draft request ID was reused for different content or revision",
					);
				return receipt.result;
			}
			if (Object.keys(doc.receipts).length >= 256)
				throw new Error(
					"Native draft receipt capacity reached; automatic pruning is unsupported",
				);
			const raw = doc.drafts[id],
				previous = raw ? parseDraft(raw) : null;
			if (
				editing
					? !previous || previous.revision !== body.revision
					: previous !== null
			)
				throw new Error(
					"Draft revision conflict; load the current draft explicitly before saving",
				);
			if (!editing && Object.keys(doc.drafts).length >= 16)
				throw new Error(
					"Native draft capacity reached; automatic pruning is unsupported",
				);
			const draft: Draft = {
				id,
				revision: (previous?.revision ?? 0) + 1,
				content,
				digest: digest(content),
				base: previous?.base ?? base(this.config),
				...(previous?.sources ? { sources: previous.sources } : {}),
			};
			const result = { id, revision: draft.revision, digest: draft.digest };
			doc.drafts[id] = JSON.stringify(draft);
			doc.receipts[key] = JSON.stringify({ request, result });
			return result;
		}, background);
	}
}
