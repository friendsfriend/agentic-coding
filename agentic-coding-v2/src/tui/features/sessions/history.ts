const readCommands = new Set([
	"help",
	"view",
	"session",
	"task",
	"refresh",
	"back",
	"forward",
	"filter",
	"sort",
	"logs",
	"evidence",
	"inspect-model",
	"skill",
]);
/** Bounded client-memory history. No confirmations/writes, disk persistence or replay. */
export class DraftHistory {
	private readonly views = new Map<
		string,
		{
			entries: string[];
			index: number | null;
			draft: string;
			recalled: string | null;
		}
	>();
	private bytes = 0;
	private readonly entryLimit = 40;
	private readonly viewLimit = 32;
	private readonly byteLimit = 64000;
	private sensitive(text: string) {
		const command = /^\/(\S+)/.exec(text)?.[1];
		return (
			text.includes("approve:") ||
			Boolean(command && !text.startsWith("//") && !readCommands.has(command))
		);
	}
	admitted(key: string, text: string) {
		if (!text.trim() || text.length > 16000 || this.sensitive(text)) return;
		let view = this.views.get(key);
		if (!view) {
			view = { entries: [], index: null, draft: "", recalled: null };
			this.views.set(key, view);
		}
		if (view.entries.at(-1) !== text) {
			view.entries.push(text);
			this.bytes += text.length;
		}
		view.index = null;
		view.draft = "";
		view.recalled = null;
		while (view.entries.length > this.entryLimit)
			this.bytes -= view.entries.shift()?.length ?? 0;
		while (this.views.size > this.viewLimit || this.bytes > this.byteLimit) {
			const first = this.views.entries().next().value;
			if (!first) break;
			this.bytes -= first[1].entries.reduce(
				(total, item) => total + item.length,
				0,
			);
			this.views.delete(first[0]);
		}
	}
	/** Plain arrow navigation never overwrites newly typed or edited text.
	 * Explicit Alt-arrow recall retains its existing draft-restoration contract. */
	canBrowseArrows(key: string, draft: string): boolean {
		return draft.length === 0 || this.views.get(key)?.recalled === draft;
	}
	recall(key: string, direction: -1 | 1, draft: string) {
		if (draft.length > 16000)
			throw new Error(
				"Long unsent drafts are preserved; local history is bounded to 16000 characters",
			);
		if (this.sensitive(draft))
			throw new Error(
				"Confirmation/mutation drafts are not captured or replaced by local history",
			);
		const view = this.views.get(key);
		if (!view?.entries.length) return null;
		if (view.index === null || view.recalled !== draft) {
			view.index = null;
			view.draft = draft;
			view.recalled = null;
		}
		if (direction > 0 && view.index === null) return null;
		const index = Math.max(
			0,
			Math.min(
				view.entries.length,
				(view.index ?? view.entries.length) + direction,
			),
		);
		if (index === view.entries.length) {
			view.index = null;
			view.recalled = null;
			return {
				text: view.draft,
				label: "Restored original unsent draft; nothing submitted",
			};
		}
		view.index = index;
		view.recalled = view.entries[index] ?? "";
		return {
			text: view.recalled,
			label: `Local accepted input ${index + 1}/${view.entries.length}; explicit submission required. Advancing past latest restores the original draft.`,
		};
	}
}
