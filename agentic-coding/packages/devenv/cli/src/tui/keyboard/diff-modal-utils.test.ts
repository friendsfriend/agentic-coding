import { describe, expect, test } from "bun:test";
import { computeInitialSplitView } from "./diff-modal-utils";

describe("computeInitialSplitView", () => {
	test("allows split by width for addition-only hunks in existing files", () => {
		const diff = "@@ -1,2 +1,3 @@\n context\n+added\n";
		expect(computeInitialSplitView(diff, 160)).toBe(true);
	});

	test("keeps truly new files unified", () => {
		const diff = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+added\n";
		expect(computeInitialSplitView(diff, 200)).toBe(false);
	});

	test("respects change metadata for new or deleted files", () => {
		const diff = "@@ -1,2 +1,3 @@\n context\n+added\n";
		expect(computeInitialSplitView(diff, 200, true)).toBe(false);
	});
});
