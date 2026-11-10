import type { Data } from "./index.ts";
export const environmentReads = [
	"discovery",
	"drafts",
	"draft",
	"trees",
	"preflights",
	"preflight",
	"promotions",
	"promotion",
	"attempts",
	"logs",
	"telemetry",
	"http-history",
	"database-history",
	"unit-starts",
] as const;
export type EnvironmentRead = (typeof environmentReads)[number];
export const environmentMutations = [
	"save",
	"capture-base",
	"save-source",
	"remove-source",
	"remove-draft",
	"preflight",
	"promote",
	"release-tree",
	"release-temporary-tree",
	"acknowledge-tree-cleanup",
	"acknowledge-attempt",
	"revoke",
	"stop-unit",
	"readd-unit",
	"release-run",
] as const;
export type EnvironmentMutation = (typeof environmentMutations)[number];
export type EnvironmentInspection = {
	operation: EnvironmentRead;
	selection: Data;
};
export type EnvironmentIntention = {
	operation: EnvironmentMutation;
	body: Data;
};
export type EnvironmentCandidate = {
	id: string;
	digest: string;
	snapshot: string;
	expiresAt: number;
};
