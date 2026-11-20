import { createSignal, onMount } from "solid-js";
import type { QuestionDraft } from "../../../questions.ts";
import type { ReviewComment } from "../../../review-feedback.ts";
import type { Review } from "../../../state.ts";
import type { ClientConnection } from "../../client/connection.ts";
export type HumanDraft = {
	requestId: string;
	comments: (ReviewComment & { id: string })[];
	general: string;
	answers: QuestionDraft[];
	globalNote: string;
	viewed: string[];
	closedFolders: string[];
	tab: number;
	highlight: number;
};
export function emptyHumanDraft(review: Review): HumanDraft {
	return {
		requestId: crypto.randomUUID(),
		comments: [],
		general: "",
		answers: (review.questions ?? []).map(() => ({
			optionIndexes: [],
			text: "",
			notes: "",
		})),
		globalNote: "",
		viewed: [],
		closedFolders: [],
		tab: 0,
		highlight: 0,
	};
}
/** Drafts are untrusted presentation data, never answers or authorization. */
export function decodeHumanDraft(content: string, review: Review): HumanDraft {
	const invalid = () =>
		new Error("Saved draft is unavailable; it was not overwritten");
	const object = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	const strings = (v: unknown): v is string[] =>
		Array.isArray(v) && v.every((item) => typeof item === "string");
	const natural = (v: unknown): v is number =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw invalid();
	}
	if (
		new TextEncoder().encode(content).length > 128000 ||
		!object(value) ||
		typeof value.requestId !== "string" ||
		!value.requestId ||
		value.requestId.length > 200 ||
		typeof value.general !== "string" ||
		typeof value.globalNote !== "string" ||
		!strings(value.viewed) ||
		!strings(value.closedFolders) ||
		!natural(value.tab) ||
		!natural(value.highlight) ||
		!Array.isArray(value.comments) ||
		!Array.isArray(value.answers)
	)
		throw invalid();
	const questions = review.questions ?? [];
	if (
		value.tab > questions.length ||
		value.highlight > (questions[value.tab]?.options.length ?? 0) ||
		value.answers.length !== questions.length
	)
		throw invalid();
	for (const [index, answer] of value.answers.entries()) {
		if (
			!object(answer) ||
			!Array.isArray(answer.optionIndexes) ||
			!answer.optionIndexes.every(
				(i) => natural(i) && i < (questions[index]?.options.length ?? 0),
			) ||
			typeof answer.text !== "string" ||
			typeof answer.notes !== "string" ||
			!(
				answer.customSelected === undefined ||
				typeof answer.customSelected === "boolean"
			)
		)
			throw invalid();
	}
	const ids = new Set<string>();
	for (const comment of value.comments) {
		if (
			!object(comment) ||
			typeof comment.id !== "string" ||
			!comment.id ||
			ids.has(comment.id) ||
			typeof comment.body !== "string"
		)
			throw invalid();
		ids.add(comment.id);
		if (comment.anchor !== undefined) {
			const a = comment.anchor;
			if (
				!object(a) ||
				typeof a.path !== "string" ||
				(a.side !== "old" && a.side !== "new") ||
				!(a.start === undefined || (natural(a.start) && a.start > 0)) ||
				!(a.end === undefined || (natural(a.end) && a.end > 0)) ||
				(a.end !== undefined &&
					(a.start === undefined || Number(a.end) < Number(a.start)))
			)
				throw invalid();
		}
	}
	return value as HumanDraft;
}
type DraftStore = {
	value: () => HumanDraft;
	change: (edit: (draft: HumanDraft) => HumanDraft) => void;
	ready: () => boolean;
	error: () => string | null;
	saving: () => boolean;
	retry: () => void;
};
const caches = new WeakMap<ClientConnection, Map<string, DraftStore>>();
/** Server-owned v2 draft storage. Coalesce pending edits, serialize versioned
 * writes and keep local text on a refusal; never replace newer text on a late read. */
export function createHumanDraft(
	client: ClientConnection,
	review: Review,
): DraftStore {
	let cache = caches.get(client);
	if (!cache) {
		cache = new Map();
		caches.set(client, cache);
	}
	const key = `${review.id}:${review.digest}`;
	const previous = cache.get(key);
	if (previous) return previous;
	for (const [id, entry] of cache) {
		if (cache.size < 100) break;
		if (entry.ready() && !entry.saving() && !entry.error()) cache.delete(id);
	}
	if (cache.size >= 100) {
		const value = emptyHumanDraft(review);
		return {
			value: () => value,
			change: () => {},
			ready: () => false,
			error: () =>
				"100 unsaved human drafts are retained; save or submit them before opening another, or restart after retaining your text",
			saving: () => false,
			retry: () => {},
		};
	}
	const [value, setValue] = createSignal(emptyHumanDraft(review));
	const [ready, setReady] = createSignal(false),
		[error, setError] = createSignal<string | null>(null),
		[saving, setSaving] = createSignal(false);
	let version = 0,
		dirty = false,
		writing = false,
		content = "";
	const flush = async () => {
		if (writing || !ready() || error()) return;
		writing = true;
		setSaving(true);
		try {
			while (dirty) {
				dirty = false;
				const next = content;
				const saved = await client.call("human.draft.save", {
					id: review.id,
					digest: review.digest,
					version,
					content: next,
				});
				version = saved.version;
			}
		} catch (e) {
			dirty = true;
			setError(
				`${e instanceof Error ? e.message : String(e)} · local draft retained`,
			);
		} finally {
			writing = false;
			setSaving(false);
		}
	};
	let loading = false;
	const load = async () => {
		if (ready() || loading) return;
		loading = true;
		try {
			const saved = await client.call("human.draft.read", { id: review.id });
			if (saved.digest !== review.digest)
				throw new Error("Saved draft belongs to another snapshot");
			if (saved.content) setValue(decodeHumanDraft(saved.content, review));
			version = saved.version;
			setError(null);
			setReady(true);
		} catch (e) {
			setError(String(e));
		} finally {
			loading = false;
		}
	};
	onMount(() => {
		void load();
	});

	const change = (edit: (draft: HumanDraft) => HumanDraft) => {
		if (!ready()) return;
		const next = edit(value());
		const serialized = JSON.stringify(next);
		if (new TextEncoder().encode(serialized).length > 128000) {
			setError("Draft exceeds 128 KB; last saved draft retained");
			return;
		}
		setValue(next);
		content = serialized;
		dirty = true;
		void flush();
	};
	const store = {
		value,
		change,
		ready,
		error,
		saving,
		retry: () => {
			setError(null);
			if (!ready()) void load();
			else void flush();
		},
	};
	cache.set(key, store);
	return store;
}
