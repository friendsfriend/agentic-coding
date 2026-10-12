/**
 * Slots-section actions for the Environments feature
 * (show-environment-instances): force release with a confirmation that names
 * the holder and the next waiter, and opening the holder's (or a waiter's)
 * workflow dashboard.
 *
 * Data lives in the slot store; navigation crosses into the shell through the
 * `openWorkflow` callback the shell root passes when it embeds this feature, so
 * this layer never owns a route or a start boundary of its own.
 */
import type { DevEnvClient } from "@devenv/core";
import type { AppStore } from "../stores/app-store.ts";
import {
	type SlotRow,
	type SlotStore,
	slotOwnerLabel,
	slotWorkflowId,
} from "../stores/slot-store.ts";
import type { UiStore } from "../stores/ui-store.ts";

/**
 * The force-release confirmation: it names the holder, names the next waiter
 * when there is one, and states that the holder's run will be stopped. Pure so a
 * test pins the text without a terminal or a modal.
 */
export function releaseConfirmationMessage(row: SlotRow): string {
	const parts = [`This stops the run held by ${slotOwnerLabel(row.holder)}.`];
	const next = row.waiting[0];
	if (next)
		parts.push(
			`The app is then granted to ${slotOwnerLabel(next.owner)}, the next waiter.`,
		);
	return parts.join(" ");
}

export function createSlotActions(
	appStore: AppStore,
	slotStore: SlotStore,
	uiStore: UiStore,
	client: DevEnvClient,
	openWorkflow?: (workflowId: string) => void,
) {
	const selectedRow = (): SlotRow | undefined =>
		slotStore.visible()[appStore.selectedIndex()];

	/** The confirmation text: holder, next waiter and that the run stops. */
	const releaseMessage = (row: SlotRow): string =>
		releaseConfirmationMessage(row);

	const requestRelease = (): void => {
		const row = selectedRow();
		if (!row) {
			uiStore.setNotification("No slot selected", "warning");
			return;
		}
		if (!row.holder) {
			uiStore.setNotification(`${row.app} has no holder`, "warning");
			return;
		}
		uiStore.setConfirmDialogTitle(`Force release ${row.app}`);
		uiStore.setConfirmDialogMessage(releaseMessage(row));
		uiStore.setConfirmDialogAction(() => () => {
			void (async () => {
				try {
					await client.releaseApp(row.app);
					await slotStore.refresh();
					uiStore.setNotification(`Released ${row.app}`, "success");
				} catch (cause) {
					uiStore.showError(
						"Force release failed",
						cause instanceof Error ? cause.message : String(cause),
					);
				}
			})();
		});
		uiStore.setShowConfirmDialog(true);
	};

	const openOwningWorkflow = (): void => {
		const row = selectedRow();
		if (!row) {
			uiStore.setNotification("No slot selected", "warning");
			return;
		}
		// The holder if an agent holds it, otherwise the first waiter.
		const owner = row.holder?.startsWith("workflow:")
			? row.holder
			: row.waiting[0]?.owner;
		const workflowId = slotWorkflowId(owner);
		if (!workflowId) {
			uiStore.setNotification("No workflow owns this app", "warning");
			return;
		}
		if (!openWorkflow) {
			uiStore.setNotification(
				"Workflow navigation needs the unified shell",
				"warning",
			);
			return;
		}
		openWorkflow(workflowId);
	};

	return { requestRelease, openOwningWorkflow };
}

export type SlotActions = ReturnType<typeof createSlotActions>;
