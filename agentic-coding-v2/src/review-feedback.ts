import { digest } from "./config.ts";
import { reviewFiles } from "./review-files.ts";
import type { Review } from "./state.ts";

/** Only an explicitly typed request is a code review. Titles and legacy
 * snapshots are never evidence that a command/schedule gate can be approved. */
export type ReviewComment = {
	body: string;
	anchor?: {
		/** Exact path from the immutable snapshot, not a current workspace path. */
		path: string;
		side: "old" | "new";
		start?: number;
		end?: number;
	};
};
export type ReviewSubmission = {
	id: string;
	revision: number;
	digest: string;
	requestId: string;
	comments: ReviewComment[];
};
export type ReviewReceipt = {
	requestId: string;
	fingerprint: string;
	revision: number;
	decision: "approved" | "changes-requested";
	comments: ReviewComment[];
};

/** Fixed, safe refusal text; the gateway may present it without exposing internals. */
export class ReviewFeedbackError extends Error {}

// Share the immutable-patch index with the file tree; binary/rename-only files
// accept file comments but never fabricate line anchors.
function snapshotAnchors(snapshot: string) {
	const anchors = new Map<string, { old: Set<number>; new: Set<number> }>();
	for (const file of reviewFiles(snapshot)) {
		const lines = { old: new Set(file.oldLines), new: new Set(file.newLines) };
		if (file.oldPath) anchors.set(`old:${file.oldPath}`, lines);
		if (file.newPath) anchors.set(`new:${file.newPath}`, lines);
	}
	return anchors;
}

export function prepareReviewSubmission(
	review: Review,
	submission: ReviewSubmission,
): ReviewReceipt {
	if (review.kind !== "code-review")
		throw new ReviewFeedbackError(
			"This request requires an explicit approval decision",
		);
	if (
		submission.id !== review.id ||
		submission.digest !== review.digest ||
		!Number.isSafeInteger(submission.revision) ||
		submission.revision < 1
	)
		throw new ReviewFeedbackError(
			"Review snapshot identity mismatch; drafts were not submitted",
		);
	if (
		typeof submission.requestId !== "string" ||
		!submission.requestId.trim() ||
		submission.requestId.length > 256 ||
		!Array.isArray(submission.comments) ||
		submission.comments.length > 200
	)
		throw new ReviewFeedbackError("Invalid review submission");
	const anchors = snapshotAnchors(review.snapshot);
	let size = 0;
	const comments: ReviewComment[] = [];
	for (const input of submission.comments) {
		if (!input || typeof input.body !== "string")
			throw new ReviewFeedbackError("Invalid review comment");
		const body = input.body.trim();
		size += Buffer.byteLength(body);
		if (size > 64_000)
			throw new ReviewFeedbackError("Review feedback exceeds 64 KB");
		// Empty/deleted drafts have no decision authority and no anchor to bind.
		if (!body) continue;
		if (!input.anchor) {
			comments.push({ body });
			continue;
		}
		const { path, side, start, end } = input.anchor;
		if (typeof path !== "string" || (side !== "old" && side !== "new"))
			throw new ReviewFeedbackError("Invalid review comment anchor");
		const file = anchors.get(`${side}:${path}`);
		if (!file)
			throw new ReviewFeedbackError(
				"Comment path is unavailable in this snapshot",
			);
		if (start === undefined && end === undefined) {
			comments.push({ body, anchor: { path, side } });
			continue;
		}
		const last = end ?? start;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(last) ||
			start === undefined ||
			last === undefined ||
			start < 1 ||
			last < start ||
			last - start > 10000
		)
			throw new ReviewFeedbackError("Invalid review comment range");
		for (let line = start; line <= last; line++)
			if (!file[side].has(line))
				throw new ReviewFeedbackError(
					"Comment range is unavailable in this snapshot",
				);
		comments.push({ body, anchor: { path, side, start, end: last } });
	}
	if (Buffer.byteLength(JSON.stringify(comments)) > 120000)
		throw new ReviewFeedbackError("Encoded review feedback exceeds 120 KB");
	if (Buffer.byteLength(JSON.stringify(comments)) > 120000)
		throw new ReviewFeedbackError(
			"Encoded review feedback exceeds 120 KB; draft retained",
		);
	const decision = comments.length ? "changes-requested" : "approved";
	const fingerprint = digest(
		JSON.stringify({
			id: review.id,
			revision: submission.revision,
			digest: review.digest,
			comments,
		}),
	);
	return {
		requestId: submission.requestId,
		fingerprint,
		revision: submission.revision,
		decision,
		comments,
	};
}
