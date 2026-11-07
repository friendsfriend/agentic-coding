import { defineDoc } from "@earendil-works/pi-durable";
import type { Profile, Skill } from "./config.ts";

// Application metadata only. Task execution status stays in pi-durable.
export const Catalog = defineDoc<{
	topics: Record<string, string>;
	tasks: Record<string, string>;
	launches: Record<string, string>;
	reviews: Record<string, string>;
	attachments: Record<string, string>;
	schedules: Record<string, string>;
	/** Permanent identity fences, optional for older native catalogs. */
	deletedSchedules?: Record<string, boolean>;
	shellStarts: Record<string, string>;
}>({
	kind: "v2.catalog",
	version: 1,
	scope: "session",
	initial: () => ({
		topics: {},
		tasks: {},
		launches: {},
		reviews: {},
		attachments: {},
		schedules: {},
		deletedSchedules: {},
		shellStarts: {},
	}),
	checkpointWhen: () => true,
});
export type Topic = { id: string; title: string; createdAt: number };
export type ExecutionPolicy = "read-only" | "workspace-write";
export type TaskInfo = {
	id: number;
	kind?: "operator-environment";
	conversationId?: number;
	baseCommit?: string;
	policy: ExecutionPolicy;
	topicId: string;
	skill: string;
	profile: string;
	repository: string;
	workspace: string;
	relatedTo: number | null;
	createdAt: number;
	reported: boolean;
};
export type Invocation = {
	baseRef?: string;
	policy: ExecutionPolicy;
	topicId: string;
	skill: string;
	profile: string;
	repository: string;
	inputs: string;
	requestId: string;
	relatedTo?: number;
};
export type TaskInput = {
	baseCommit: string;
	policy: ExecutionPolicy;
	topicId: string;
	skill: Skill;
	profile: Profile;
	repository: string;
	inputs: string;
	relatedTo: number | null;
	occurrence: string | null;
};
export type Review = {
	id: string;
	taskId: number;
	topicId: string;
	path: string;
	title: string;
	snapshot: string;
	digest: string;
	state:
		| "pending"
		| "approved"
		| "changes-requested"
		| "rejected"
		| "cancelled";
	comments: string;
	revision: number;
	createdAt: number;
};
export type Attachment = {
	id: string;
	taskId: number;
	filename: string;
	mediaType: string;
	caption: string;
};
export type Timing =
	| { kind: "once"; at: number }
	| { kind: "interval"; everyMs: number; anchor: number }
	| {
			kind: "calendar";
			timezone: string;
			weekdays: number[];
			hour: number;
			minute: number;
	  };
export type Schedule = {
	lastError: string | null;
	id: string;
	invocation: Invocation;
	timing: Timing;
	nextDue: number | null;
	state: "enabled" | "paused";
	revision: number;
	activeTask: number | null;
	lastSlot: number | null;
	lateGraceMs: number | null;
	history: { due: number; task: number | null; result: string }[];
};
export function decode<T>(value: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (cause) {
		throw new Error(
			"Invalid persisted v2 metadata; refusing to guess or replace state",
			{ cause },
		);
	}
}
export const values = <T>(
	entries: Readonly<Record<string, string>> | undefined,
): T[] => Object.values(entries ?? {}).map(decode<T>);
