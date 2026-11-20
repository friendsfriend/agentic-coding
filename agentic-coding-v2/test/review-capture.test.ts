import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureReview, git } from "../src/git.ts";
import { prepareReviewSubmission } from "../src/review-feedback.ts";
import { createRepository } from "./fixtures/repository.ts";

test("untracked snapshots retain exact new-side line anchors and newline state", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-review-"));
	try {
		await createRepository(root);
		fs.mkdirSync(path.join(root, "a"));
		fs.writeFileSync(path.join(root, "a", "new.ts"), "first\nlast");
		fs.writeFileSync(path.join(root, "empty.ts"), "");
		fs.writeFileSync(path.join(root, "artifact.bin"), Buffer.from([1, 0, 255]));
		const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
		const captured = await captureReview(
			fs.realpathSync(root),
			".",
			baseCommit,
		);
		expect(captured.snapshot).toContain("\\ No newline at end of file");
		expect(captured.snapshot).toContain(
			"Binary source unavailable · 3 bytes · sha256",
		);
		const review = {
			...captured,
			id: "review-1",
			taskId: 1,
			topicId: "topic",
			path: ".",
			title: "New files",
			kind: "code-review" as const,
			baseCommit,
			state: "pending" as const,
			comments: "",
			revision: 1,
			createdAt: 0,
		};
		const receipt = prepareReviewSubmission(review, {
			id: review.id,
			digest: review.digest,
			revision: 1,
			requestId: "submit",
			comments: [
				{
					body: "Second line",
					anchor: { path: "a/new.ts", side: "new", start: 2 },
				},
				{ body: "Empty file", anchor: { path: "empty.ts", side: "new" } },
				{
					body: "Inspect artifact separately",
					anchor: { path: "artifact.bin", side: "new" },
				},
			],
		});
		expect(receipt.comments).toHaveLength(3);
		expect(() =>
			prepareReviewSubmission(review, {
				id: review.id,
				digest: review.digest,
				revision: 1,
				requestId: "bad-binary",
				comments: [
					{
						body: "Not a source line",
						anchor: { path: "artifact.bin", side: "new", start: 1 },
					},
				],
			}),
		).toThrow("range is unavailable");
		expect(receipt.decision).toBe("changes-requested");
		// Captured review content remains usable even after the working file changes.
		fs.writeFileSync(path.join(root, "a", "new.ts"), "replacement");
		expect(review.snapshot).toContain("+last");
		fs.writeFileSync(path.join(root, "too-large.txt"), "x".repeat(512001));
		await expect(
			captureReview(fs.realpathSync(root), ".", baseCommit),
		).rejects.toThrow("512 KB");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
