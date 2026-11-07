import { record } from "../../protocol/index.ts";
import type { Navigation, View } from "./navigation.ts";
export type Viewpoint = { id: string; name: string; view: View };
const pages = [
	"opencode",
	"pi",
	"pi-durable",
	"orchestrator",
	"session",
	"tasks",
	"environments",
	"providers",
	"profiles",
	"observability",
	"schedules",
	"wiki",
	"settings",
];
function checkedView(value: unknown): View {
	const item = record(value);
	if (
		!pages.includes(String(item.page)) ||
		!(typeof item.resource === "string" || item.resource === null) ||
		!Number.isSafeInteger(item.selection) ||
		Number(item.selection) < 0 ||
		!Number.isSafeInteger(item.scroll) ||
		Number(item.scroll) < 0 ||
		typeof item.filter !== "string" ||
		typeof item.sort !== "string" ||
		typeof item.draft !== "string" ||
		!Array.isArray(item.expanded) ||
		!item.expanded.every((value) => typeof value === "string") ||
		!["sessions", "content", "viewpoints"].includes(String(item.focus))
	)
		throw new Error("Invalid saved viewpoint");
	if (/^\s*\/settings-apply(?:\s|$)/.test(item.draft))
		throw new Error(
			"Settings confirmations cannot be saved or restored in viewpoints",
		);
	record(item.detail);
	if (JSON.stringify(item).length > 128000)
		throw new Error("Saved view is oversized");
	return structuredClone(item) as View;
}
/** Data-only bookmark collection. Restoration has no reference to client commands. */
export class Viewpoints {
	items: Viewpoint[] = [];
	save(name: string, current: View) {
		if (!name.trim() || name.length > 100 || this.items.length >= 64)
			throw new Error("Viewpoint name or capacity invalid");
		const item = { id: crypto.randomUUID(), name, view: checkedView(current) };
		this.items.push(item);
		return item;
	}
	remove(id: string) {
		this.items = this.items.filter((item) => item.id !== id);
	}
	restore(id: string, navigation: Navigation) {
		const item = this.items.find((item) => item.id === id);
		if (!item) throw new Error("Viewpoint no longer exists");
		navigation.go(checkedView(item.view));
	}
	export() {
		return JSON.stringify({ version: 1, items: this.items });
	}
	load(bytes: string) {
		if (bytes.length > 1_000_000)
			throw new Error("Viewpoint storage is oversized");
		const value = record(JSON.parse(bytes));
		if (
			value.version !== 1 ||
			!Array.isArray(value.items) ||
			value.items.length > 64
		)
			throw new Error("Invalid viewpoint storage");
		const items = value.items.map((entry) => {
			const item = record(entry);
			if (
				typeof item.id !== "string" ||
				typeof item.name !== "string" ||
				item.name.length > 100
			)
				throw new Error("Invalid viewpoint entry");
			return { id: item.id, name: item.name, view: checkedView(item.view) };
		});
		if (new Set(items.map((item) => item.id)).size !== items.length)
			throw new Error("Duplicate viewpoint identity");
		this.items = items;
	}
}
