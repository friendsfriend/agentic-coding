import type { DependencyNode } from "@devenv/ui";
import type { AppDetailStore, AppStore } from "../stores";
import { isDownKey, isUpKey } from "./nav-keys";
import {
	isNextPanelKey,
	isPrevPanelKey,
	nextPanelIndex,
	prevPanelIndex,
} from "./panel-keys";
import type { KeyboardEvent } from "./types";

/**
 * Flatten visible tree nodes to compute flat index count and find node at index.
 */
function flattenTree(nodes: DependencyNode[]): DependencyNode[] {
	const result: DependencyNode[] = [];
	function walk(list: DependencyNode[]) {
		for (const n of list) {
			result.push(n);
			if (n.expanded && n.children.length > 0) walk(n.children);
		}
	}
	walk(nodes);
	return result;
}

function nodeAtIndex(
	nodes: DependencyNode[],
	index: number,
): DependencyNode | null {
	const flat = flattenTree(nodes);
	return flat[index] ?? null;
}

export function handleAppDetailKeys(
	event: KeyboardEvent,
	appDetailStore: AppDetailStore,
	_appStore: AppStore,
	expandNode: (nodeKey: string) => void,
): boolean {
	const app = appDetailStore.appDetailApp();
	if (!app) return false;

	const syncDependencyTreeFocus = (panelIndex: number) => {
		const focusTree =
			panelIndex === 2 && appDetailStore.actionTargets().length > 0;
		appDetailStore.setDependencyTreeFocused(focusTree);
		if (focusTree) {
			const maxIndex = Math.max(
				0,
				flattenTree(appDetailStore.dependencyTreeNodes()).length - 1,
			);
			appDetailStore.setDependencyTreeSelectedIndex((idx) =>
				Math.min(idx, maxIndex),
			);
		}
	};

	// ── Panel focus navigation (always active, even when tree is focused) ──
	const panelCount = appDetailStore.appDetailPanelCount;
	if (panelCount > 1) {
		if (isNextPanelKey(event)) {
			const next = nextPanelIndex(
				appDetailStore.appDetailPanelIndex(),
				panelCount,
			);
			appDetailStore.setAppDetailPanelIndex(next);
			syncDependencyTreeFocus(next);
			return true;
		}
		if (isPrevPanelKey(event)) {
			const prev = prevPanelIndex(
				appDetailStore.appDetailPanelIndex(),
				panelCount,
			);
			appDetailStore.setAppDetailPanelIndex(prev);
			syncDependencyTreeFocus(prev);
			return true;
		}
	}

	// ── Tree focused keys ────────────────────────────────────────────────
	const isTreeFocused = appDetailStore.dependencyTreeFocused();
	if (isTreeFocused) {
		const nodes = appDetailStore.dependencyTreeNodes();
		const flatCount = flattenTree(nodes).length;

		switch (event.name) {
			case "j":
			case "down": {
				const cur = appDetailStore.dependencyTreeSelectedIndex();
				if (cur < flatCount - 1) {
					appDetailStore.setDependencyTreeSelectedIndex(cur + 1);
				}
				return true;
			}
			case "k":
			case "up": {
				const cur = appDetailStore.dependencyTreeSelectedIndex();
				if (cur > 0) {
					appDetailStore.setDependencyTreeSelectedIndex(cur - 1);
				}
				return true;
			}
			case "return": {
				// Expand/collapse selected node
				const idx = appDetailStore.dependencyTreeSelectedIndex();
				const found = nodeAtIndex(nodes, idx);
				if (found) expandNode(found.key);
				return true;
			}
			case "escape": {
				appDetailStore.setDependencyTreeFocused(false);
				return true;
			}
		}
		return false;
	}

	// When a scrollable panel is focused, delegate j/k to its scrollbox ref
	if (isDownKey(event)) {
		const refs = appDetailStore.appDetailScrollBoxRefs;
		const ref = refs[appDetailStore.appDetailPanelIndex()];
		ref?.scrollBy(1);
		if (ref) return true;
	}
	if (isUpKey(event)) {
		const refs = appDetailStore.appDetailScrollBoxRefs;
		const ref = refs[appDetailStore.appDetailPanelIndex()];
		ref?.scrollBy(-1);
		if (ref) return true;
	}

	// ── Main detail view keys ────────────────────────────────────────────
	switch (event.name) {
		case "d": {
			// Focus dependency tree if deps exist
			if (appDetailStore.actionTargets().length > 0) {
				appDetailStore.setAppDetailPanelIndex(2);
				appDetailStore.setDependencyTreeFocused(true);
				appDetailStore.setDependencyTreeSelectedIndex(0);
				return true;
			}
			return false;
		}
	}

	return false;
}
