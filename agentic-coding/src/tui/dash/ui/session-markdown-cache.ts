import {
	type MarkdownBlockPart,
	type StreamingMarkdownBlockParts,
	streamingMarkdownBlockParts,
} from "@ui";
import { AGENT_SESSION_BLOCK_LIMIT } from "../agent-session.ts";

/** Per-view LRU, bounded to the transcript projection rather than all messages
 * ever rendered. Eviction releases the source text and parsed parts together;
 * revisiting an evicted block simply parses it again. */
export class SessionMarkdownCache {
	private readonly entries = new Map<string, StreamingMarkdownBlockParts>();

	get size(): number {
		return this.entries.size;
	}

	parts(key: string, content: string): readonly MarkdownBlockPart[] {
		const previous = this.entries.get(key);
		const next =
			previous?.content === content
				? previous
				: streamingMarkdownBlockParts(previous, content);
		// Refresh recency even when a streaming block only grows under one key.
		this.entries.delete(key);
		this.entries.set(key, next);
		if (this.entries.size > AGENT_SESSION_BLOCK_LIMIT) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		return next.parts;
	}
}
