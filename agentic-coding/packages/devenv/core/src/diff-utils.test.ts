import { describe, expect, test } from "bun:test";
import { isDiffFileAddedOrDeleted } from "./diff-utils";

describe("isDiffFileAddedOrDeleted", () => {
	test("does not treat addition-only hunk in existing file as new file", () => {
		const diff = "@@ -1,2 +1,3 @@\n context\n+added\n";
		expect(isDiffFileAddedOrDeleted(diff)).toBe(false);
	});

	test("detects new file from /dev/null header", () => {
		const diff = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+added\n";
		expect(isDiffFileAddedOrDeleted(diff)).toBe(true);
	});

	test("detects deleted file from /dev/null header", () => {
		const diff = "--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n";
		expect(isDiffFileAddedOrDeleted(diff)).toBe(true);
	});
});
