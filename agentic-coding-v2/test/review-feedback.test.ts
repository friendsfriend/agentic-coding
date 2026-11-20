import { expect, test } from "bun:test";
import { digest } from "../src/config.ts";
import {
	prepareReviewSubmission,
	type ReviewSubmission,
} from "../src/review-feedback.ts";
import type { Review } from "../src/state.ts";

const snapshot = `diff --git a/src/old.ts b/src/new.ts
similarity index 50%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -8,2 +8,3 @@
 kept
-removed
+added
+another
`;
const review: Review = {
	id: "review-42",
	kind: "code-review",
	taskId: 7,
	topicId: "topic",
	path: ".",
	title: "Review",
	snapshot,
	digest: digest(snapshot),
	state: "pending",
	comments: "",
	revision: 1,
	createdAt: 0,
};
function submission(comments: ReviewSubmission["comments"]): ReviewSubmission {
	return {
		id: review.id,
		digest: review.digest,
		revision: 1,
		requestId: "submit-1",
		comments,
	};
}

test("only surviving nonempty feedback requests changes; normalized retries have stable identity", () => {
	const empty = prepareReviewSubmission(
		review,
		submission([{ body: " \n\t " }]),
	);
	expect(empty.decision).toBe("approved");
	expect(empty.comments).toEqual([]);
	expect(() =>
		prepareReviewSubmission(review, submission([{ body: "\0".repeat(22000) }])),
	).toThrow("Encoded review feedback");
	const feedback = submission([
		{ body: "  Please explain this.\n" },
		{
			body: "Fix the removed side",
			anchor: { path: "src/old.ts", side: "old", start: 9 },
		},
		{
			body: "Fix this range",
			anchor: { path: "src/new.ts", side: "new", start: 9, end: 10 },
		},
		{
			body: "File-level feedback",
			anchor: { path: "src/new.ts", side: "new" },
		},
	]);
	const receipt = prepareReviewSubmission(review, feedback);
	expect(receipt.decision).toBe("changes-requested");
	expect(receipt.comments).toHaveLength(4);
	expect(receipt.comments[0]?.body).toBe("Please explain this.");
	expect(
		prepareReviewSubmission(review, {
			...feedback,
			comments: receipt.comments,
		}),
	).toEqual(receipt);
});

test("snapshot/range validation refuses retargeting and never treats legacy gates as code review", () => {
	for (const anchor of [
		{ path: "src/old.ts", side: "new" as const, start: 9 },
		{ path: "src/new.ts", side: "new" as const, start: 10, end: 11 },
		{ path: "../elsewhere", side: "new" as const },
	])
		expect(() =>
			prepareReviewSubmission(review, submission([{ body: "Fix", anchor }])),
		).toThrow();
	expect(() =>
		prepareReviewSubmission(review, { ...submission([]), digest: "changed" }),
	).toThrow("snapshot identity");
	expect(() =>
		prepareReviewSubmission(
			{ ...review, kind: undefined, title: "Code review" },
			submission([]),
		),
	).toThrow("explicit approval");
	expect(() =>
		prepareReviewSubmission(review, submission([{ body: "a".repeat(64_001) }])),
	).toThrow("64 KB");
});
