import {
	type MarkdownBlockPart,
	type StreamingMarkdownBlockParts,
	streamingMarkdownBlockParts,
} from "../../presentation/components/markdownBlocks.ts";

/** Original per-view LRU, with a UI-only 240-document cap. Neither this cap nor
 * a cache hit admits another native history read. Sources leaving the observed
 * window are released; cached syntax styles still belong to the renderer. */
export class SessionMarkdownCache {
	private readonly entries = new Map<string, StreamingMarkdownBlockParts>();

	parts(key: string, content: string): readonly MarkdownBlockPart[] {
		const previous = this.entries.get(key);
		const next =
			previous?.content === content
				? previous
				: streamingMarkdownBlockParts(previous, content);
		this.entries.delete(key);
		this.entries.set(key, next);
		if (this.entries.size > 240) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		return next.parts;
	}

	retain(keys: ReadonlySet<string>): void {
		for (const key of this.entries.keys())
			if (!keys.has(key)) this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}
