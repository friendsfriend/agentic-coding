import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { captureApprovedDesign } from "../src/workflow/adapters.ts";
import { clarificationDigest } from "../src/workflow/runtime/clarification-actions.ts";

test("approval capture admits only bounded confined UTF-8 bytes and pins the same source digest", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "approved-design-"));
	const worktree = path.join(root, "repo");
	const directory = path.join(worktree, "openspec/changes/approved");
	const file = path.join(directory, "design.md");
	fs.mkdirSync(directory, { recursive: true });
	const capture = () =>
		Effect.runPromise(captureApprovedDesign(worktree, "approved"));
	try {
		expect(await capture()).toBeUndefined();
		for (const unsafe of [
			Buffer.alloc(0),
			Buffer.alloc(128 * 1024 + 1, 120),
			Buffer.from([0xff]),
		]) {
			fs.writeFileSync(file, unsafe);
			expect(await capture()).toBeUndefined();
		}
		const content = "An agreed design\n";
		fs.writeFileSync(file, content);
		expect(await capture()).toEqual({
			content,
			digest: clarificationDigest(content),
		});
		expect(
			await Effect.runPromise(captureApprovedDesign(worktree, "../approved")),
		).toBeUndefined();
		fs.unlinkSync(file);
		const outside = path.join(root, "outside.md");
		fs.writeFileSync(outside, "Outside the worktree");
		fs.symlinkSync(outside, file);
		expect(await capture()).toBeUndefined();
		fs.unlinkSync(file);
		fs.mkdirSync(file);
		expect(await capture()).toBeUndefined();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
