import type { Data } from "../../protocol/index.ts";
import type { UiWorkspaceLayout } from "../../protocol/viewpoints.ts";
export type Page =
	| "opencode"
	| "pi"
	| "pi-durable"
	| "orchestrator"
	| "session"
	| "tasks"
	| "environments"
	| "providers"
	| "profiles"
	| "skills"
	| "observability"
	| "schedules"
	| "wiki"
	| "settings";
export type View = {
	page: Page;
	resource: string | null;
	selection: number;
	filter: string;
	sort: string;
	expanded: string[];
	scroll: number;
	focus: "sessions" | "content" | "viewpoints";
	draft: string;
	detail: Data;
	workspace: UiWorkspaceLayout;
};
export function view(
	page: Page = "orchestrator",
	resource: string | null = null,
): View {
	return {
		page,
		resource,
		selection: 0,
		filter: "",
		sort: "default",
		expanded: [],
		scroll: 0,
		focus: "content",
		draft: "",
		detail: {},
		workspace: { mode: "expanding", side: "left" },
	};
}
/** Navigation stores state, not commands. Back restores the actual previous view. */
export class Navigation {
	current: View = view();
	private backStack: View[] = [];
	private forwardStack: View[] = [];
	go(next: View) {
		this.backStack.push(structuredClone(this.current));
		if (this.backStack.length > 100) this.backStack.shift();
		this.forwardStack = [];
		this.current = structuredClone(next);
	}
	back() {
		const previous = this.backStack.pop();
		if (previous) {
			this.forwardStack.push(structuredClone(this.current));
			this.current = previous;
		}
	}
	forward() {
		const next = this.forwardStack.pop();
		if (next) {
			this.backStack.push(structuredClone(this.current));
			this.current = next;
		}
	}
}
