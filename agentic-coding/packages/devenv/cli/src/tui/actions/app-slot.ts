/**
 * The developer-facing half of the app-slot rule.
 *
 * An app runs once at a time. When an agent holds an app's slot, the TUI's run
 * action refuses before it starts anything and says what is happening in human
 * terms, naming the holding workflow. The server enforces the same rule for
 * every client with the machine-readable `held-by <workflow>` error, so a failed
 * read here falls through instead of blocking a legitimate run.
 */
import type { AppSlot, DevEnvClient } from "@devenv/core";

/**
 * The refusal text the run action shows, or `undefined` when the app is free.
 *
 * It stays short enough for the CLI's single-line toast (about 70 columns) and
 * says what to do, because the human path has no queue and never starts by
 * itself; the workflow id stays in the server's machine-readable
 * `held-by <workflow>` refusal.
 */
export async function agentSlotRefusal(
	client: DevEnvClient,
	appIdent: string,
	appName = appIdent,
): Promise<string | undefined> {
	let slots: AppSlot[];
	try {
		slots = await client.getAppSlots();
	} catch {
		// The check is an early refusal, not the enforcement: the run request is
		// refused by the server too, so an unreadable slot list is not a failure.
		return undefined;
	}
	const holder = slots.find((slot) => slot.app === appIdent)?.holder ?? null;
	if (!holder?.startsWith("workflow:")) return undefined;
	return `An agent run is using ${appName}. Wait for it to finish, then press s again.`;
}
