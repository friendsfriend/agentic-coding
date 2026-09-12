import type { ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";

export const APP_DETAIL_PANEL_COUNT = 4;

import type {
	ActionTarget,
	App,
	ChangeRequest,
	ContainerStats,
} from "@devenv/types";
import type { AppDetailKind, DependencyNode } from "@devenv/ui";

export function createAppDetailStore() {
	const [appDetailApp, setAppDetailApp] = createSignal<App | undefined>(
		undefined,
	);
	const [appDetailGitInfo, setAppDetailGitInfo] = createSignal<
		{ branch: string; status: string } | undefined
	>(undefined);
	const [appDetailChangeRequests, setAppDetailCRs] = createSignal<
		ChangeRequest[]
	>([]);
	const [appDetailChangeRequestsLoading, setAppDetailCRsLoading] =
		createSignal(false);
	const [appDetailLogs, setAppDetailLogs] = createSignal("");
	const [appDetailStatsHistory, setAppDetailStatsHistory] = createSignal<
		number[]
	>([]);
	const [appDetailMemHistory, setAppDetailMemHistory] = createSignal<number[]>(
		[],
	);
	const [appDetailLatestStats, setAppDetailLatestStats] = createSignal<
		ContainerStats | undefined
	>(undefined);
	const [appDetailLoading, setAppDetailLoading] = createSignal(false);
	const [appDetailKind, setAppDetailKind] = createSignal<AppDetailKind>("app");
	const [actionTargets, setActionTargets] = createSignal<ActionTarget[]>([]);
	const [actionTargetsLoading, setActionTargetsLoading] = createSignal(false);
	const [dependencyTreeFocused, setDependencyTreeFocused] = createSignal(false);
	const [dependencyTreeSelectedIndex, setDependencyTreeSelectedIndex] =
		createSignal(0);
	const [dependencyTreeNodes, setDependencyTreeNodes] = createSignal<
		DependencyNode[]
	>([]);

	// Panel focus navigation
	const [appDetailPanelIndex, setAppDetailPanelIndex] = createSignal(0);
	const appDetailScrollBoxRefs: (ScrollBoxRenderable | undefined)[] = [];

	return {
		appDetailApp,
		setAppDetailApp,
		appDetailGitInfo,
		setAppDetailGitInfo,
		appDetailChangeRequests,
		setAppDetailCRs,
		appDetailChangeRequestsLoading,
		setAppDetailCRsLoading,
		appDetailLogs,
		setAppDetailLogs,
		appDetailStatsHistory,
		setAppDetailStatsHistory,
		appDetailMemHistory,
		setAppDetailMemHistory,
		appDetailLatestStats,
		setAppDetailLatestStats,
		appDetailLoading,
		setAppDetailLoading,
		appDetailKind,
		setAppDetailKind,
		actionTargets,
		setActionTargets,
		actionTargetsLoading,
		setActionTargetsLoading,
		dependencyTreeFocused,
		setDependencyTreeFocused,
		dependencyTreeSelectedIndex,
		setDependencyTreeSelectedIndex,
		dependencyTreeNodes,
		setDependencyTreeNodes,

		// Panel focus navigation
		appDetailPanelIndex,
		setAppDetailPanelIndex,
		appDetailPanelCount: APP_DETAIL_PANEL_COUNT,
		get appDetailScrollBoxRefs() {
			return appDetailScrollBoxRefs;
		},
	};
}

export type AppDetailStore = ReturnType<typeof createAppDetailStore>;
