import { formatProfileLabel } from "@devenv/ui";
import type { KeyEvent } from "@opentui/core";
import type { DockerActions } from "../actions";
import type { UiStore } from "../stores";
import type { ActionRunStore } from "../stores/action-run-store";
import type { AppStore } from "../stores/app-store";
import { actionTreeCopyText } from "../views/action-run-copy";
import { copyText } from "./global-keys";
import { isDownKey, isUpKey } from "./nav-keys";

const shiftedDown = (event: KeyEvent) =>
	event.name === "J" ||
	event.sequence === "J" ||
	(event.name === "j" && event.shift);
const shiftedUp = (event: KeyEvent) =>
	event.name === "K" ||
	event.sequence === "K" ||
	(event.name === "k" && event.shift);
const isTopKey = (event: KeyEvent) => event.name === "g" && !event.shift;
const isBottomKey = (event: KeyEvent) =>
	event.name === "G" || (event.name === "g" && event.shift);

export function handleActionsKeys(
	event: KeyEvent,
	store: ActionRunStore,
	appStore: AppStore,
	dockerActions?: Pick<DockerActions, "cancelAction">,
	uiStore?: Pick<UiStore, "setNotification">,
	copy = (text: string) =>
		uiStore ? copyText(text, uiStore) : Promise.resolve(false),
): boolean {
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.sequence === "\x1b" ||
		event.name === "L" ||
		event.sequence === "L"
	) {
		appStore.popModal("actions");
		return true;
	}
	if (event.name === "c" && store.run()?.status === "active") {
		const appIdent = store.run()?.appIdent;
		if (appIdent) void dockerActions?.cancelAction(appIdent);
		store.cancelSelected();
		return true;
	}
	if (
		store.focusedPanel() === 0 &&
		(event.name === "y" || event.sequence === "y")
	) {
		const node = store.selectedNode();
		if (node && node.kind !== "loadOlder") {
			void copy(actionTreeCopyText(node, formatProfileLabel));
		}
		return true;
	}
	if (event.name === "enter" || event.name === "return") {
		const node = store.selectedNode();
		if (node?.kind === "loadOlder") void store.loadOlderHistory();
		else if (node?.hasChildren) {
			if (node.kind === "action") store.toggleRunCollapsed(node.run.id);
			else store.toggleStep(node.step.id);
		}
		return true;
	}
	if (shiftedDown(event)) {
		store.setFocusedPanel(store.focusedPanel() === 0 ? 1 : 0);
		return true;
	}
	if (shiftedUp(event)) {
		store.setFocusedPanel(store.focusedPanel() === 1 ? 0 : 1);
		return true;
	}
	if (!store.run()) return false;
	if (store.focusedPanel() === 0) {
		const actions = store
			.visibleNodes()
			.filter((node) => node.kind === "action");
		if (isTopKey(event) || isBottomKey(event)) {
			const action = actions[isTopKey(event) ? 0 : actions.length - 1];
			if (action) store.focusTreeNode(action);
			return true;
		}
		if (event.name === "n" || event.name === "p") {
			const index = actions.findIndex(
				(node) => node.run.id === store.selectedRunId(),
			);
			const next =
				event.name === "n"
					? Math.min(actions.length - 1, index + 1)
					: Math.max(0, index - 1);
			if (actions[next]) store.focusTreeNode(actions[next]);
			return true;
		}
	}
	if (store.focusedPanel() === 0 && (isDownKey(event) || isUpKey(event))) {
		const nodes = store.visibleNodes();
		if (nodes.length === 0) return true;
		const currentIndex = nodes.findIndex(
			(node) => node.key === store.focusedTreeKey(),
		);
		const index = currentIndex < 0 ? 0 : currentIndex;
		const next = isDownKey(event)
			? Math.min(nodes.length - 1, index + 1)
			: Math.max(0, index - 1);
		store.focusTreeNode(nodes[next]);
		// Tree rows are one terminal line each. Keep keyboard-selected rows
		// reachable instead of letting focus move into clipped content.
		store.treeScrollBoxRef?.scrollTo(next);
		return true;
	}
	if (store.focusedPanel() === 1) {
		const sb = store.logScrollBoxRef;
		if (isDownKey(event)) {
			sb?.scrollBy(1);
			return true;
		}
		if (isUpKey(event)) {
			sb?.scrollBy(-1);
			return true;
		}
		if (event.name === "d") {
			sb?.scrollBy(Math.floor((sb.viewport.height || 10) / 2));
			return true;
		}
		if (event.name === "u") {
			sb?.scrollBy(-Math.floor((sb.viewport.height || 10) / 2));
			return true;
		}
		if (event.name === "g" && !event.shift) {
			sb?.scrollTo(0);
			return true;
		}
		if (event.name === "G" || (event.name === "g" && event.shift)) {
			sb?.scrollTo(sb.scrollHeight);
			return true;
		}
	}
	return false;
}
