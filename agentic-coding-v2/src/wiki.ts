import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import type { Data } from "./protocol/index.ts";
import type { Runtime } from "./runtime.ts";
import type { Invocation } from "./state.ts";

export type WikiPage = {
	id: string;
	title: string;
	content: string;
	revision: number;
	digest: string;
	updatedAt: number;
};
export type WikiComment = {
	id: string;
	pageId: string;
	pageRevision: number;
	comment: string;
	fingerprint: string;
	invocation: Invocation;
	taskId: number | null;
	createdAt: number;
};
export const WikiState = defineDoc<{
	pages: Record<string, string>;
	comments: Record<string, string>;
}>({
	kind: "v2.wiki",
	version: 1,
	scope: "session",
	initial: () => ({ pages: {}, comments: {} }),
	checkpointWhen: () => true,
});
const parse = <T>(raw: string): T => JSON.parse(raw) as T;
const slug = (value: unknown) => {
	const id = text(value, "page identity", 80);
	if (
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
		/\s/.test(id) ||
		["constructor", "prototype"].includes(id)
	)
		throw new Error("Invalid wiki page identity");
	return id;
};
const fields = (data: Data, names: string[]) => {
	if (Object.keys(data).some((key) => !names.includes(key)))
		throw new Error("Unsupported wiki field");
};
const safeRevision = (value: unknown) => {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error("Invalid wiki revision");
	return Number(value);
};
export class Wiki {
	private candidates = new Map<
		string,
		{
			id: string;
			snapshot: string;
			digest: string;
			expiresAt: number;
			page: {
				id: string;
				title: string;
				content: string;
				baseRevision: number;
			};
		}
	>();
	constructor(private app: Runtime) {}
	private async state() {
		return (
			(await this.app.harness.snapshot(WikiState, context)) ?? {
				pages: {},
				comments: {},
			}
		);
	}
	async list() {
		return Object.values((await this.state()).pages).map((raw) => {
			const { content: _content, ...page } = parse<WikiPage>(raw);
			return page;
		});
	}
	async read(id: unknown) {
		const state = await this.state(),
			raw = state.pages[slug(id)];
		if (!raw) throw new Error("Wiki page unavailable");
		return {
			page: parse<WikiPage>(raw),
			comments: Object.values(state.comments)
				.map((raw) => parse<WikiComment>(raw))
				.filter((comment) => comment.pageId === id)
				.map(
					({
						fingerprint: _fingerprint,
						invocation: _invocation,
						...comment
					}) => comment,
				),
		};
	}
	async preview(input: Data) {
		fields(input, ["id", "title", "content", "baseRevision"]);
		const id = slug(input.id),
			title = text(input.title, "wiki title", 256),
			baseRevision = safeRevision(input.baseRevision);
		if (typeof input.content !== "string" || input.content.length > 32000)
			throw new Error("Wiki content oversized");
		const state = await this.state(),
			previous = state.pages[id];
		if (
			(previous ? parse<WikiPage>(previous).revision : 0) !== baseRevision ||
			(!previous && Object.keys(state.pages).length >= 64)
		)
			throw new Error("Stale wiki revision or page limit");
		const page = { id, title, content: input.content, baseRevision },
			snapshot = JSON.stringify(page, null, 2),
			now = Date.now();
		for (const [id, candidate] of this.candidates)
			if (candidate.expiresAt <= now) this.candidates.delete(id);
		if (this.candidates.size >= 16) throw new Error("Too many wiki candidates");
		const candidate = {
			id: crypto.randomUUID(),
			snapshot,
			digest: digest(snapshot),
			expiresAt: now + 600000,
			page,
		};
		this.candidates.set(candidate.id, candidate);
		const { page: _page, ...view } = candidate;
		return view;
	}
	async apply(input: Data) {
		fields(input, ["id", "approval"]);
		const candidate =
			typeof input.id === "string" ? this.candidates.get(input.id) : null;
		if (
			!candidate ||
			candidate.expiresAt <= Date.now() ||
			input.approval !== `approve:${candidate.digest}`
		)
			throw new Error("Exact fresh wiki approval required");
		const page = await this.app.home.commit(async (tx) => {
			const state = await tx.doc(WikiState),
				previous = state.pages[candidate.page.id];
			if (
				(previous ? parse<WikiPage>(previous).revision : 0) !==
					candidate.page.baseRevision ||
				(!previous && Object.keys(state.pages).length >= 64)
			)
				throw new Error("Stale wiki page revision");
			const page = {
				id: candidate.page.id,
				title: candidate.page.title,
				content: candidate.page.content,
				revision: candidate.page.baseRevision + 1,
				digest: digest(candidate.page.content),
				updatedAt: Date.now(),
			};
			state.pages[page.id] = JSON.stringify(page);
			return page;
		}, context);
		this.candidates.delete(candidate.id);
		return page;
	}
	async comment(input: Data) {
		fields(input, [
			"pageId",
			"pageRevision",
			"comment",
			"profile",
			"repository",
			"baseRef",
			"requestId",
		]);
		const id = text(input.requestId, "comment request identity", 128),
			pageId = slug(input.pageId),
			pageRevision = safeRevision(input.pageRevision),
			comment = text(input.comment, "wiki comment", 4000),
			profile = text(input.profile, "profile", 128),
			repository = text(input.repository, "repository", 4096),
			baseRef = text(input.baseRef, "Git base", 512);
		if (
			!/^[A-Za-z0-9:_-]+$/.test(id) ||
			/\s/.test(id) ||
			["__proto__", "constructor", "prototype"].includes(id)
		)
			throw new Error("Invalid comment request identity");
		const fingerprint = digest(
			JSON.stringify({
				pageId,
				pageRevision,
				comment,
				profile,
				repository,
				baseRef,
			}),
		);
		let record: WikiComment | null = null;
		const state = await this.state(),
			previous = state.comments[id];
		if (previous) {
			record = parse<WikiComment>(previous);
			if (record.fingerprint !== fingerprint)
				throw new Error("Comment identity reused for different content");
		} else {
			const pageRaw = state.pages[pageId],
				page = pageRaw ? parse<WikiPage>(pageRaw) : null;
			if (
				!page ||
				page.revision !== pageRevision ||
				Object.keys(state.comments).length >= 128
			)
				throw new Error("Stale wiki page or comment limit");
			const skill = this.app.config.skills.find(
				(skill) => skill.id === "wiki-comment",
			);
			if (skill?.origin !== "system" || !skill.readOnly)
				throw new Error("Native read-only wiki-comment skill unavailable");
			const invocation: Invocation = {
				topicId: `wiki-${pageId}`,
				skill: "wiki-comment",
				profile,
				repository,
				baseRef,
				policy: "read-only",
				inputs: JSON.stringify({
					page,
					comment,
					instruction:
						"Review this exact snapshot; propose changes only, never apply them.",
				}),
				requestId: `wiki-comment:${id}`,
			};
			const validated = await this.app.validateInvocation(invocation);
			invocation.baseRef = validated.baseCommit;
			invocation.repository = validated.repository;
			record = {
				id,
				pageId,
				pageRevision,
				comment,
				fingerprint,
				invocation,
				taskId: null,
				createdAt: Date.now(),
			};
			const candidate = record;
			record = await this.app.home.commit(async (tx) => {
				const doc = await tx.doc(WikiState);
				if (doc.comments[id]) {
					const existing = parse<WikiComment>(doc.comments[id]);
					if (existing.fingerprint !== fingerprint)
						throw new Error("Comment identity conflict");
					return existing;
				}
				if (
					!doc.pages[pageId] ||
					parse<WikiPage>(doc.pages[pageId]).revision !== pageRevision ||
					Object.keys(doc.comments).length >= 128
				)
					throw new Error("Wiki page changed before comment admission");
				doc.comments[id] = JSON.stringify(candidate);
				return candidate;
			}, context);
		}
		if (record.taskId !== null) return { taskId: record.taskId };
		const task = await this.app.startTask(record.invocation);
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(WikiState),
				raw = doc.comments[id];
			if (!raw) throw new Error("Comment admission record unavailable");
			const current = parse<WikiComment>(raw);
			if (
				current.fingerprint !== fingerprint ||
				(current.taskId !== null && current.taskId !== task)
			)
				throw new Error("Comment admission conflict");
			current.taskId = task;
			doc.comments[id] = JSON.stringify(current);
		}, context);
		return { taskId: task };
	}
}
