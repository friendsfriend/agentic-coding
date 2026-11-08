import { record } from "./index.ts";
export const uiPages = [
	"opencode",
	"pi",
	"pi-durable",
	"orchestrator",
	"session",
	"tasks",
	"environments",
	"providers",
	"profiles",
	"skills",
	"observability",
	"schedules",
	"wiki",
	"settings",
] as const;
export type UiPage = (typeof uiPages)[number];
export type UiWorkspaceLayout = {
	mode: "expanding" | "permanent";
	side: "left" | "right";
};
/** Closed display preferences, never shell configuration or execution state. */
export function uiWorkspaceLayout(value: unknown): UiWorkspaceLayout {
	const data = record(value);
	if (
		Object.keys(data).length !== 2 ||
		!Object.hasOwn(data, "mode") ||
		!Object.hasOwn(data, "side") ||
		(data.mode !== "expanding" && data.mode !== "permanent") ||
		(data.side !== "left" && data.side !== "right")
	)
		throw new Error("Invalid UI-only workspace layout");
	return { mode: data.mode, side: data.side };
}
export type UiView = {
	page: UiPage;
	resource: string | null;
	selection: number;
	filter: string;
	sort: "default" | "newest";
	expanded: string[];
	scroll: number;
	focus: "sessions" | "content" | "viewpoints";
	transcriptFollow?: { id: number; following: boolean };
	workspace?: UiWorkspaceLayout;
};
export type NativeViewpoint = {
	id: string;
	name: string;
	revision: number;
	view: UiView;
	updatedAt: number;
};
const keys = [
	"page",
	"resource",
	"selection",
	"filter",
	"sort",
	"expanded",
	"scroll",
	"focus",
];
/** Closed UI-only DTO: reject drafts, logs, confirmations and execution-shaped extras. */
export function uiView(value: unknown): UiView {
	const data = record(value);
	if (
		Object.keys(data).some(
			(key) =>
				!keys.includes(key) &&
				key !== "transcriptFollow" &&
				key !== "workspace",
		) ||
		keys.some((key) => !Object.hasOwn(data, key)) ||
		!uiPages.includes(data.page as UiPage) ||
		!(
			data.resource === null ||
			(typeof data.resource === "string" && data.resource.length <= 256)
		) ||
		!Number.isSafeInteger(data.selection) ||
		Number(data.selection) < 0 ||
		Number(data.selection) > 1000000 ||
		!Number.isSafeInteger(data.scroll) ||
		Number(data.scroll) < 0 ||
		Number(data.scroll) > 10000000 ||
		typeof data.filter !== "string" ||
		data.filter.length > 256 ||
		!["default", "newest"].includes(String(data.sort)) ||
		!["sessions", "content", "viewpoints"].includes(String(data.focus)) ||
		!Array.isArray(data.expanded) ||
		data.expanded.length > 128 ||
		!data.expanded.every(
			(entry) => typeof entry === "string" && entry.length <= 256,
		)
	)
		throw new Error("Invalid UI-only viewpoint state");
	if (Object.hasOwn(data, "workspace")) uiWorkspaceLayout(data.workspace);
	if (Object.hasOwn(data, "transcriptFollow")) {
		const follow = record(data.transcriptFollow);
		if (
			Object.keys(follow).length !== 2 ||
			!Object.hasOwn(follow, "id") ||
			!Object.hasOwn(follow, "following") ||
			!Number.isSafeInteger(follow.id) ||
			Number(follow.id) < 1 ||
			typeof follow.following !== "boolean" ||
			!(
				(data.page === "orchestrator" && data.resource === null) ||
				(data.page === "session" &&
					typeof data.resource === "string" &&
					/^\d+$/.test(data.resource) &&
					Number(data.resource) === follow.id)
			)
		)
			throw new Error("Invalid UI-only transcript follow state");
	}
	return structuredClone(data) as UiView;
}
export function nativeViewpoint(value: unknown): NativeViewpoint {
	const data = record(value);
	if (
		Object.keys(data).some(
			(key) => !["id", "name", "revision", "view", "updatedAt"].includes(key),
		) ||
		typeof data.id !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			data.id,
		) ||
		typeof data.name !== "string" ||
		!data.name.trim() ||
		data.name.length > 100 ||
		!Number.isSafeInteger(data.revision) ||
		Number(data.revision) < 1 ||
		!Number.isSafeInteger(data.updatedAt) ||
		Number(data.updatedAt) < 0
	)
		throw new Error("Invalid native viewpoint");
	uiView(data.view);
	return structuredClone(data) as NativeViewpoint;
}
