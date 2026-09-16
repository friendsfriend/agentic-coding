/** @jsxImportSource @opentui/solid */
// Dashboard-only composition root (isolate-workflow-dashboard-mode, task 1.2).
//
// `agentic-coding dash` is launched by Herdr for one explicit workflow. It
// renders the shared dashboard implementation directly — never the feature
// shell — so no tab row, breadcrumb, location picker, Home/Settings route or
// observability body is mounted, and no shell key layer or destination handler
// is registered. The dashboard's own panels, operational dialogs,
// subscriptions and lifecycle ownership are unchanged.
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createSignal, Show } from "solid-js";
import { App as DashApp, type WorkflowHeaderInfo } from "../dash/App";
import { Header } from "../dash/ui/Header";
import { QuitConfirmModal } from "../lifecycle/QuitConfirmModal";
import { StatusBar } from "../otel/components/StatusBar";
import { uiColors } from "../otel/ui/colors";
import { ErrorModalOverlay } from "../shared/ErrorModalOverlay";

export interface DashboardRootProps {
	repo: string;
	workflowId: string;
	/** Interactive dummy data, as in `dash --profile test`. */
	profile?: "test";
	keymap: Keymap<Renderable, KeyEvent>;
}

/**
 * The whole dash presentation: the dashboard's own header/footer pair (the
 * shell header is not part of this surface) plus the shared overlays the
 * dashboard does not render itself. Notifications and the modal-help overlay
 * are owned by the dashboard component.
 */
export function DashboardRoot(props: DashboardRootProps) {
	// Workflow header context pushed up from the dashboard's single data source.
	const [header, setHeader] = createSignal<WorkflowHeaderInfo | null>(null);
	return (
		<box
			backgroundColor={uiColors.bgBase}
			width="100%"
			height="100%"
			style={{ flexDirection: "column" }}
		>
			{/* Keep the header row's height while the first observation loads, so
			    the layout does not shift under the panels. */}
			<Show when={header()} fallback={<box height={2} />}>
				{(workflow) => (
					<Header
						change={workflow().change}
						phase={workflow().phase}
						branch={workflow().branch}
						updated={workflow().updated}
					/>
				)}
			</Show>
			{/* The one blank row between the header and the panels, matching every
			    page of the full application. */}
			<box style={{ height: 1, flexShrink: 0 }} />
			<box style={{ flexGrow: 1, minHeight: 0 }}>
				<DashApp
					repo={props.repo}
					workflowId={props.workflowId}
					profile={props.profile}
					keymap={props.keymap}
					onHeader={setHeader}
				/>
			</box>
			<box style={{ height: 1, flexShrink: 0 }} />
			<StatusBar />
			<ErrorModalOverlay keymap={props.keymap} />
			<QuitConfirmModal />
		</box>
	);
}
