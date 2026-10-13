// The (mtime, size) text cache behind the sidebar's task-progress reads.
//
// The sidebar poll repeats one `tasks.md` read per listed workflow every 5 s;
// the cache is what makes an unchanged repository cost a stat instead of a read
// plus a regex over every checklist. These tests pin the two halves of that
// trade: an untouched file is not re-read, and a file that moved on is.
import { expect, test } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cachedText,
	cachedTextEntryCount,
} from "../src/server/operations/file-cache.ts";

test("a file is re-read only when its mtime or size changed", () => {
	const dir = mkdtempSync(join(tmpdir(), "file-cache-"));
	try {
		const path = join(dir, "tasks.md");
		writeFileSync(path, "- [ ] a\n");
		const original = statSync(path);
		expect(cachedText(path)).toBe("- [ ] a\n");
		// Same size and, after the restore below, the same mtime: the cache cannot
		// tell the file was rewritten, which is exactly the trade the key names —
		// and the reason a poll can repeat the read for free.
		writeFileSync(path, "- [x] a\n");
		utimesSync(path, original.atimeMs / 1000, original.mtimeMs / 1000);
		// The premise of the assertion below, checked rather than assumed: the
		// restored timestamp is the one the stat reports.
		expect(statSync(path).mtimeMs).toBe(original.mtimeMs);
		expect(cachedText(path)).toBe("- [ ] a\n");
		// What a step commit writes: a newer mtime re-reads the file.
		const later = new Date(Date.now() + 2_000);
		utimesSync(path, later, later);
		expect(cachedText(path)).toBe("- [x] a\n");
		// A rewrite inside one mtime tick still lands, because the size moved.
		writeFileSync(path, "- [x] a\n- [x] b\n");
		utimesSync(path, later, later);
		expect(cachedText(path)).toBe("- [x] a\n- [x] b\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file that disappears reads as empty and is not served from the cache", () => {
	const dir = mkdtempSync(join(tmpdir(), "file-cache-missing-"));
	try {
		const path = join(dir, "tasks.md");
		expect(cachedText(path)).toBe("");
		writeFileSync(path, "- [ ] a\n");
		expect(cachedText(path)).toBe("- [ ] a\n");
		rmSync(path);
		// The row is gone: the caller sees the file a fresh read would produce, not
		// the text it held a moment ago.
		expect(cachedText(path)).toBe("");
		writeFileSync(path, "- [x] a\n- [x] b\n");
		expect(cachedText(path)).toBe("- [x] a\n- [x] b\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the cache stays bounded over many files", () => {
	const dir = mkdtempSync(join(tmpdir(), "file-cache-bound-"));
	try {
		for (let index = 0; index < 600; index += 1)
			writeFileSync(join(dir, `tasks-${index}.md`), `- [ ] ${index}\n`);
		const first = join(dir, "tasks-0.md");
		// One read per file, more than the cache holds: the oldest entries are
		// evicted so a long-lived server cannot grow this without bound.
		for (let index = 0; index < 600; index += 1)
			cachedText(join(dir, `tasks-${index}.md`));
		expect(cachedTextEntryCount()).toBeLessThanOrEqual(512);
		// An evicted file is simply read again.
		expect(cachedText(first)).toBe("- [ ] 0\n");
		expect(cachedTextEntryCount()).toBeLessThanOrEqual(512);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
