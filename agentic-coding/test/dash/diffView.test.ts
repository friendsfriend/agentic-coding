import { expect, test } from "bun:test";
import {
	buildSplitDiffLines,
	parseDiffLines,
} from "../../src/tui/shared/diffView";

const DIFF = [
	"--- a/file.ts",
	"+++ b/file.ts",
	"@@ -1,4 +1,5 @@",
	" context one",
	"-old line",
	"+new line",
	"+extra line",
	" trailing context",
	"\\ No newline at end of file",
].join("\n");

test("parseDiffLines types headers, hunk headers and content", () => {
	const lines = parseDiffLines(DIFF);
	expect(lines.map((line) => line.type)).toEqual([
		"header",
		"header",
		"header",
		"context",
		"removed",
		"added",
		"added",
		"context",
		"context",
	]);
	const removed = lines.find((line) => line.type === "removed");
	expect(removed?.content).toBe("old line");
	expect(removed?.oldLineNum).toBe(2);
	const added = lines.filter((line) => line.type === "added");
	expect(added.map((line) => line.newLineNum)).toEqual([2, 3]);
});

test("buildSplitDiffLines pairs removed/added runs and keeps context rows", () => {
	const split = buildSplitDiffLines(parseDiffLines(DIFF));
	// 3 headers + `context one` + 2 paired rows + 2 trailing context rows.
	expect(split).toHaveLength(8);
	expect(split.filter((line) => line.header).length).toBe(3);

	// Context lines appear on both sides with their old/new numbers.
	const contextRow = split[3];
	expect(contextRow?.oldLine?.content).toBe("context one");
	expect(contextRow?.newLine?.content).toBe("context one");
	expect(contextRow?.oldLine?.type).toBe("context");
	expect(contextRow?.newLine?.type).toBe("context");

	// Removed run zips with the added run, then the surplus added line keeps
	// only a new side.
	const paired = split[4];
	expect(paired?.oldLine?.content).toBe("old line");
	expect(paired?.newLine?.content).toBe("new line");
	const extra = split[5];
	expect(extra?.newLine?.content).toBe("extra line");
	expect(extra?.oldLine).toBeUndefined();

	// The trailing plain context lines keep both sides.
	expect(split[6]?.oldLine?.content).toBe("trailing context");
	expect(split[6]?.newLine?.content).toBe("trailing context");
});

test("buildSplitDiffLines handles a standalone removed run", () => {
	const split = buildSplitDiffLines(
		parseDiffLines(["@@ -1,2 +1,2 @@", "-gone", " kept"].join("\n")),
	);
	const removedOnly = split.find((line) => line.oldLine?.type === "removed");
	expect(removedOnly?.oldLine?.content).toBe("gone");
	// A removed-only row has no new side (the branch the all-context/paired
	// cases never exercise).
	expect(removedOnly?.newLine).toBeUndefined();
});
