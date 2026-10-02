// Agents-panel Enter routing for a `pi-durable` row (add-pi-durable-runtime,
// dashboard-agent-session-view). The full interactive session view (live
// transcript, steer/follow-up input, abort) is a follow-up: this renders one
// bounded, defensively-parsed snapshot of the conversation's view state as
// markdown text for the existing OpenSpec-artifact verdict modal, so Enter on
// a durable agent shows something real instead of silently doing nothing.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive, version-tolerant read of pi-durable's `ConversationView` shape
 * (`docs["pi.live"]`, `docs["pi.inbox"]`, `entries`): every field is read as
 * unknown and checked, so a shape drift in the experimental package degrades
 * to a shorter summary instead of throwing in the dashboard. */
export function renderAgentSessionSummary(value: unknown): string {
	if (!isRecord(value)) return "No session data yet.";
	const docs = isRecord(value.docs) ? value.docs : {};
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	const inbox = isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
	const entries = Array.isArray(value.entries) ? value.entries : [];
	const busy = live !== undefined && live.run !== undefined;
	const tools = live && Array.isArray(live.tools) ? live.tools : [];
	const runningTool = tools.find(
		(tool) => isRecord(tool) && tool.status === "running",
	);
	const queued = inbox && Array.isArray(inbox.items) ? inbox.items.length : 0;
	const lines = [
		`**Status:** ${busy ? "working" : "idle"}`,
		...(runningTool && isRecord(runningTool)
			? [`**Running tool:** ${String(runningTool.name ?? "unknown")}`]
			: []),
		...(queued > 0 ? [`**Queued submissions:** ${queued}`] : []),
		`**Transcript entries:** ${entries.length}`,
		"",
		"_Live steering, follow-up and abort are not available from this view yet;_",
		"_use the workflow CLI (`agentic-coding workflow question|ask`) or the agent's own tools._",
	];
	return lines.join("\n");
}
