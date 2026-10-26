import { expect, test } from "bun:test";
import { markdownBlockParts } from "@agentic-coding/ui";
import { AGENT_SESSION_BLOCK_LIMIT } from "../../src/tui/dash/agent-session.ts";
import { SessionMarkdownCache } from "../../src/tui/dash/ui/session-markdown-cache.ts";

test("a long-open view retains at most one projection of markdown messages", () => {
	const cache = new SessionMarkdownCache();
	const firstText = "# First\n\nOriginal body.\n";
	const first = cache.parts("first", firstText);
	for (let index = 0; index < 10_000; index++) {
		cache.parts(
			`message-${index}`,
			`# Message ${index}\n\n${"body ".repeat(80)}`,
		);
		if (cache.size > AGENT_SESSION_BLOCK_LIMIT)
			throw new Error(`markdown cache exceeded projection limit at ${index}`);
	}
	expect(cache.size).toBe(AGENT_SESSION_BLOCK_LIMIT);
	const revisited = cache.parts("first", firstText);
	expect(revisited).toEqual(first);
	// The old text/parts were evicted, not just hidden behind a bounded key list.
	expect(revisited[0]).not.toBe(first[0]);
	expect(cache.size).toBe(AGENT_SESSION_BLOCK_LIMIT);
});

test("streaming and unchanged messages refresh recency and reuse settled parts", () => {
	const cache = new SessionMarkdownCache();
	const text = "# Plan\n\nStep one.\n";
	const start = cache.parts("active", text);
	for (let index = 0; index < AGENT_SESSION_BLOCK_LIMIT - 1; index++)
		cache.parts(`old-${index}`, `# Old ${index}\n\nBody.\n`);
	expect(cache.parts("active", text)).toBe(start);
	// Access made the oldest active message newest, so another insertion must
	// evict an old settled message instead of the currently streaming one.
	cache.parts("new", "# New\n\nBody.\n");
	const grown = `${text}\nStep two.\n`;
	const next = cache.parts("active", grown);
	expect(next[0]).toBe(start[0]);
	expect(next).toEqual(markdownBlockParts(grown));
	expect(cache.size).toBe(AGENT_SESSION_BLOCK_LIMIT);
});

test("replacement or shrinking text never reuses another document's parts", () => {
	const cache = new SessionMarkdownCache();
	const initial = cache.parts("one", "# One\n\nLong body.\n");
	const changed = cache.parts("one", "# Two\n\nOther body.\n");
	expect(changed).toEqual(markdownBlockParts("# Two\n\nOther body.\n"));
	expect(changed[0]).not.toBe(initial[0]);
	expect(cache.parts("one", "# Two\n")).toEqual(markdownBlockParts("# Two\n"));
	expect(cache.size).toBe(1);
});
