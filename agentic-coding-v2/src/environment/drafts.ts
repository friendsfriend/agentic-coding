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
	clearRetainedTree,
	type Draft,
	type DraftData,
	type Receipt,
	recordStagedTree,
	releaseTreeRequest,
	removeDraft,
	removeSource,
	type SourceDraft,
	sourceBinding,
	sourceBindingDigest,
	stagedTreeReceipt,
	stageSource,
	stored,
} from "./definition-draft-data.ts";
import { inspectDefinition } from "./definition-preflight.ts";
import { preflightRequest } from "./definition-preflight-request.ts";
import { inspectDestination } from "./definition-promotion.ts";
import {
	acknowledgePromotion,
	beginPromotion,
	finishPromotion,
	promotionAttempts,
} from "./definition-promotion-attempts.ts";
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
import {
	assembleStagedTree,
	releaseStagedTree,
	retainedStagedTrees,
	stagedTreeIdentity,
} from "./definition-staged-tree.ts";
import { within } from "./path-within.ts";

const DraftState = defineDoc<DraftData>({
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
	private activePromotions = new Set<string>();
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
		const tree = stagedTreeReceipt(doc ?? {}, id);
		return {
			...draft,
			preflightReports,
			sourceBindings: (draft.sources ?? []).map(({ repository, file }) => ({
				bindingDigest: sourceBindingDigest(repository, file),
				repository,
				file,
			})),
			schema: schema(this.config, draft),
			stagedTree: tree
				? {
						revision: tree.revision,
						digest: tree.digest,
						treeDigest: tree.treeDigest,
						fileCount: tree.fileCount,
						bytes: tree.bytes,
						observedAt: tree.observedAt,
						// A recorded identity for another revision cannot promote.
						current:
							tree.revision === draft.revision && tree.digest === draft.digest,
						retained: tree.retained
							? {
									name: tree.retained.name,
									retainedAt: tree.retained.retainedAt,
									present: retainedStagedTrees(this.config).includes(
										tree.retained.name,
									),
								}
							: null,
					}
				: null,
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
	/** Historical summaries only; independent of draft existence and live files. */
	async preflights() {
		privateState(this.config);
		const doc = await this.engine().snapshot(Preflights, background);
		return Object.values(doc?.reports ?? {})
			.map((raw) => {
				const { id, draftId, revision, digest, observedAt, ordinal } =
					stored<Preflight>(raw);
				return { id, draftId, revision, digest, observedAt, ordinal };
			})
			.sort((a, b) => b.ordinal - a.ordinal);
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
			retain,
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
			if (retain) {
				const name = stagedTreeIdentity(draft).treeDigest;
				for (const otherId of Object.keys(drafts.trees ?? {})) {
					if (
						otherId !== id &&
						stagedTreeReceipt(drafts, otherId)?.retained?.name === name
					)
						throw new Error(
							"Retained tree is owned by another draft; cross-draft retention sharing is unsupported",
						);
				}
			}
			const report: Preflight = {
				...(candidate
					? inspectStagedCandidate(this.config, draft)
					: tree
						? assembleStagedTree(this.config, draft, { retain })
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
			// A verified tree becomes a durable digest-only identity for this exact
			// revision, so promotion can require it without retaining the tree.
			if (tree && "accepted" in report && report.accepted) {
				const assembled = report as {
						candidateDigest: string;
						treeDigest: string;
					},
					previous = stagedTreeReceipt(drafts, id),
					retained = retain ? { name: assembled.treeDigest } : undefined;
				recordStagedTree(
					drafts,
					draft,
					stagedTreeIdentity(draft),
					assembled.candidateDigest,
					retained,
				);
				// The superseded tree is released only by its own recorded digest.
				if (previous?.retained && previous.retained.name !== retained?.name)
					releaseStagedTree(this.config, previous.retained.name);
			}
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
		const removed = await this.engine().commit(async (tx) => {
			const drafts = await tx.doc(DraftState),
				receipt = stagedTreeReceipt(drafts, String(body.id ?? "")),
				result = removeDraft(drafts, body);
			return { result, retained: receipt?.retained?.name ?? null };
		}, background);
		// Deletion is committed first; only then is the draft's own tree released.
		if (removed.retained) releaseStagedTree(this.config, removed.retained);
		return removed.result;
	}
	/** Retained trees are disclosed by digest and metadata; contents stay withheld. */
	async trees() {
		privateState(this.config);
		const snapshot = await this.engine().snapshot(DraftState, background),
			drafts: Readonly<DraftData> = snapshot ?? { drafts: {}, receipts: {} },
			present = new Set(retainedStagedTrees(this.config)),
			owned = Object.values(drafts.trees ?? {})
				.map((raw) => stored<{ retained?: { name: string } }>(raw))
				.flatMap((receipt) =>
					receipt.retained ? [receipt.retained.name] : [],
				),
			records = Object.entries(drafts.trees ?? {}).flatMap(([id, raw]) => {
				const receipt = stored<{
					retained?: { name: string; retainedAt: string };
					revision: number;
					digest: string;
					treeDigest: string;
					fileCount: number;
					bytes: number;
				}>(raw);
				return receipt.retained
					? [
							{
								draftId: id,
								revision: receipt.revision,
								digest: receipt.digest,
								name: receipt.retained.name,
								treeDigest: receipt.treeDigest,
								fileCount: receipt.fileCount,
								bytes: receipt.bytes,
								retainedAt: receipt.retained.retainedAt,
								present: present.has(receipt.retained.name),
							},
						]
					: [];
			});
		return {
			trees: records,
			// Present directories no record owns are disclosed, never deleted here.
			unowned: [...present].filter((name) => !owned.includes(name)),
			authority:
				"Retention metadata only. A retained tree is inspection history: it grants no source identity, base freshness, runtime readiness, review approval or publication authority, and promotion still requires the recorded digest.",
		};
	}
	/** Explicit digest-addressed release of one retained tree. */
	async releaseTree(body: Record<string, unknown>) {
		privateState(this.config);
		const { name, request, key } = releaseTreeRequest(body),
			recorded: Readonly<DraftData> = (await this.engine().snapshot(
				DraftState,
				background,
			)) ?? {
				drafts: {},
				receipts: {},
			},
			previous = recorded.receipts[key];
		if (previous) {
			const receipt = stored<{ request: string; result: unknown }>(previous);
			if (receipt.request !== request)
				throw new Error("Release request ID reused for different input");
			return receipt.result;
		}
		const owned = Object.values(recorded.trees ?? {}).some(
			(raw) =>
				stored<{ retained?: { name: string } }>(raw).retained?.name === name,
		);
		if (!owned && !retainedStagedTrees(this.config).includes(name))
			throw new Error(
				"Unknown retained tree; release requires a recorded or present digest",
			);
		const released = releaseStagedTree(this.config, name).released;
		return this.engine().commit(async (tx) => {
			const drafts = await tx.doc(DraftState),
				retry = drafts.receipts[key];
			if (retry) {
				const receipt = stored<{ request: string; result: unknown }>(retry);
				if (receipt.request !== request)
					throw new Error("Release request ID reused for different input");
				return receipt.result;
			}
			const owner = clearRetainedTree(drafts, name),
				result = {
					name,
					released,
					owner: owner?.draftId ?? null,
					revision: owner?.revision ?? null,
				};
			drafts.receipts[key] = JSON.stringify({ request, result });
			return result;
		}, background);
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
	async attempts() {
		privateState(this.config);
		return promotionAttempts(
			await this.engine().snapshot(Promotions, background),
		);
	}
	async acknowledgeAttempt(body: Record<string, unknown>) {
		privateState(this.config);
		return this.engine().commit(
			async (tx) =>
				acknowledgePromotion(
					await tx.doc(Promotions),
					body,
					this.activePromotions,
				),
			background,
		);
	}
	async promote(body: Record<string, unknown>) {
		privateState(this.config);
		const intent = promotionRequest(body);
		if (this.activePromotions.has(intent.key))
			throw new Error("This promotion request is still active");
		this.activePromotions.add(intent.key);
		let markerCommitted = false,
			writeStarted = false;
		try {
			// This commit must finish durably before any publication effect starts.
			const replay = await this.engine().commit(async (tx) => {
				const records = await tx.doc(Promotions),
					recorded = replayPromotion(records, intent);
				if (recorded) return recorded;
				beginPromotion(records, intent);
				return null;
			}, background);
			if (replay) return replay;
			markerCommitted = true;
			return await this.engine().commit(async (tx) => {
				const records = await tx.doc(Promotions);
				// Check pending state before effects. This tentative transition and the
				// receipt become durable together only when this transaction commits.
				finishPromotion(records, intent.key, "completed");
				const record = recordPromotion(
					this.config,
					records,
					await tx.doc(DraftState),
					intent,
					() => {
						writeStarted = true;
					},
				);
				return record;
			}, background);
		} catch (error) {
			// Only known pre-rename failures are safe to retire automatically.
			// Otherwise the committed pending marker survives, even if a file write
			// succeeded but its native receipt failed to persist.
			if (markerCommitted && !writeStarted) {
				await this.engine().commit(
					async (tx) =>
						finishPromotion(
							await tx.doc(Promotions),
							intent.key,
							"failed-before-write",
						),
					background,
				);
			}
			throw error;
		} finally {
			this.activePromotions.delete(intent.key);
		}
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
