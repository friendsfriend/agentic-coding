import type { Data } from "./index.ts";
export type ProviderActionOperation =
	| "comment-change"
	| "approve-exact-change"
	| "unapprove-change"
	| "comment-issue"
	| "close-issue"
	| "retry-job"
	| "cancel-job"
	| "rebase-change"
	| "reply-discussion"
	| "resolve-discussion"
	| "set-issue-labels"
	| "set-issue-assignees";
export type ProviderActionIntent = {
	provider: string;
	operation: ProviderActionOperation;
	repo: string;
	number: number;
	thread?: string;
	payload: Data;
	requestId: string;
};
export type ProviderActionCandidate = {
	id: string;
	provider: string;
	snapshot: string;
	digest: string;
	expiresAt: number;
};
export type ProviderActionReceipt = {
	id: string;
	provider: string;
	operation: ProviderActionOperation;
	target: string;
	destination: string;
	digest: string;
	status: "uncertain" | "acknowledged";
	result: Data | null;
	updatedAt: number;
};
