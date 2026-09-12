// Bounded Herdr publication boundary for the sidebar projection
// (improve-herdr-workflow-sidebar).
//
// Two transports, one envelope policy:
//   - metadata: the shared `herdr` CLI port (`src/herdr-client.ts`), the same
//     `.result` envelope every other workflow call parses;
//   - the transient native Agents view: `agent.view.set` / `agent.view.clear`
//     are socket-only, so this module owns the one minimal request/response
//     exchange over `HERDR_SOCKET_PATH`.
//
// Everything here is best-effort presentation: no failure may change workflow
// revisions, capabilities, effect attempts, or agent processes.
import { createConnection, type Socket } from "node:net";
import { decodeHerdrResult } from "../herdr-client.ts";
import type { HerdrPort } from "./adapters.ts";
import {
	agentListResult,
	emptyResult,
	paneListResult,
	tabListResult,
	workspaceListResult,
} from "./herdr-schema.ts";
import {
	agentViewClearParams,
	agentViewSetParams,
	SIDEBAR_SOURCE,
	type SidebarClear,
	type SidebarObservation,
	type SidebarPaneCard,
	type SidebarPublication,
	type SidebarWorkspaceCard,
	type UnmanagedPane,
	type UnmanagedWorkspace,
} from "./sidebar.ts";

/** One bounded diagnostic for the whole integration, never a flood. */
export interface SidebarDiagnostics {
	report(message: string): void;
}

export const SIDEBAR_SOCKET_TIMEOUT_MS = 2_000;

async function call(
	herdr: HerdrPort,
	args: string[],
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) throw new Error("sidebar publication was cancelled");
	return herdr.callAsync ? herdr.callAsync(args, signal) : herdr.call(...args);
}

/** The `agent.view.set` request line. */
export function agentViewSetRequest(id = "agentic-coding-view-set"): string {
	return `${JSON.stringify({
		id,
		method: "agent.view.set",
		params: agentViewSetParams(),
	})}\n`;
}

/** The `agent.view.clear` request line (source-guarded on the server side). */
export function agentViewClearRequest(
	id = "agentic-coding-view-clear",
): string {
	return `${JSON.stringify({
		id,
		method: "agent.view.clear",
		params: agentViewClearParams(),
	})}\n`;
}

/** Parse one response envelope from the socket: `{id, result}` or
 * `{id, error:{code,message}}`. Anything else is a bounded error. */
export function parseHerdrSocketResponse(line: string): { result: unknown } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error("herdr socket returned a malformed response");
	}
	if (!parsed || typeof parsed !== "object")
		throw new Error("herdr socket returned a malformed response");
	const envelope = parsed as { error?: { code?: string; message?: string } };
	if (envelope.error) {
		const code = envelope.error.code ?? "error";
		const message = String(envelope.error.message ?? "").slice(0, 200);
		throw new Error(`herdr socket ${code}: ${message}`);
	}
	return { result: (parsed as { result?: unknown }).result };
}

/**
 * One request/response exchange over the Herdr socket. Bounded framing (a
 * single newline-terminated response line, capped), an explicit timeout, and
 * unconditional connection cleanup on abort or completion.
 */
export function herdrSocketRequest(
	socketPath: string,
	request: string,
	options: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? SIDEBAR_SOCKET_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? 64 * 1024;
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("sidebar view request was cancelled"));
			return;
		}
		let settled = false;
		let buffer = "";
		const socket: Socket = createConnection(socketPath);
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		const onAbort = () =>
			finish(new Error("sidebar view request was cancelled"));
		const timer = setTimeout(
			() => finish(new Error("herdr socket request timed out")),
			timeoutMs,
		);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(request));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > maxBytes) {
				finish(new Error("herdr socket response exceeded its bound"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			// Ignore blank keepalive lines; the first real envelope decides.
			if (!line) {
				buffer = buffer.slice(newline + 1);
				return;
			}
			try {
				const parsed = parseHerdrSocketResponse(line);
				finish(undefined, parsed.result);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("error", (error: Error) => finish(error));
		socket.on("close", () =>
			finish(new Error("herdr socket closed before responding")),
		);
	});
}

/** Install the transient custom Agents view. Explicit opt-in only: the view is
 * server-scoped and singular, so this replaces whatever view is active. */
export async function installSidebarView(options: {
	socketPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH;
	if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
	await herdrSocketRequest(socketPath, agentViewSetRequest(), options);
}

/** Clear the custom view, guarded by this integration's source id so another
 * tool's view is never removed. */
export async function clearSidebarView(options: {
	socketPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH;
	if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
	await herdrSocketRequest(socketPath, agentViewClearRequest(), options);
}

/** Publish one pane card: one `report-metadata` call per card, with the owned
 * tokens only. Existing tokens of other sources are untouched. */
export async function publishPaneCard(
	herdr: HerdrPort,
	card: SidebarPaneCard,
	signal?: AbortSignal,
): Promise<void> {
	const args = ["pane", "report-metadata", card.paneId, "--source", SOURCE];
	for (const [name, value] of Object.entries(card.tokens))
		args.push("--token", `${name}=${value}`);
	decodeHerdrResult(emptyResult, await call(herdr, args, signal));
}

export async function publishWorkspaceCard(
	herdr: HerdrPort,
	card: SidebarWorkspaceCard,
	signal?: AbortSignal,
): Promise<void> {
	const args = [
		"workspace",
		"report-metadata",
		card.workspaceId,
		"--source",
		SOURCE,
	];
	for (const [name, value] of Object.entries(card.tokens))
		args.push("--token", `${name}=${value}`);
	decodeHerdrResult(emptyResult, await call(herdr, args, signal));
}

async function clearTokens(
	herdr: HerdrPort,
	kind: "pane" | "workspace",
	clear: SidebarClear,
	signal?: AbortSignal,
): Promise<void> {
	const args = [kind, "report-metadata", clear.targetId, "--source", SOURCE];
	for (const token of clear.tokens) args.push("--clear-token", token);
	decodeHerdrResult(emptyResult, await call(herdr, args, signal));
}

const SOURCE = SIDEBAR_SOURCE;

/**
 * Publish a projection: pane cards, space cards, then the obsolete managed
 * tokens that dropped out of the managed set. Sequential, bounded, and
 * per-target resilient: a pane or space that vanished between the live read
 * and the write is skipped (nothing to publish or clear there), and any other
 * single-target failure is reported once instead of aborting the remaining
 * cards. The caller coalesces refreshes so overlapping drains cannot
 * interleave here.
 */
export async function publishSidebar(
	herdr: HerdrPort,
	publication: SidebarPublication,
	signal?: AbortSignal,
	diagnostics?: SidebarDiagnostics,
): Promise<void> {
	const attempt = async (action: () => Promise<void>) => {
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// A target that no longer exists is not a failure: there is nothing
			// to publish or clear there.
			if (/not[_ ]found/i.test(message)) return;
			diagnostics?.report(message);
		}
	};
	for (const card of publication.panes)
		await attempt(() => publishPaneCard(herdr, card, signal));
	for (const card of publication.workspaces)
		await attempt(() => publishWorkspaceCard(herdr, card, signal));
	for (const clear of publication.clearedPanes)
		await attempt(() => clearTokens(herdr, "pane", clear, signal));
	for (const clear of publication.clearedWorkspaces)
		await attempt(() => clearTokens(herdr, "workspace", clear, signal));
}

/** Live Herdr observations: one batched read for every pane's runtime state,
 * plus the panes and workspaces that carry no workflow association. Never one
 * workflow CLI call per pane. */
export async function readSidebarObservations(
	herdr: HerdrPort,
	signal?: AbortSignal,
): Promise<{
	observations: SidebarObservation[];
	unmanagedPanes: UnmanagedPane[];
	unmanagedWorkspaces: UnmanagedWorkspace[];
}> {
	const agents = decodeHerdrResult(
		agentListResult,
		await call(herdr, ["agent", "list"], signal),
	);
	const panes = decodeHerdrResult(
		paneListResult,
		await call(herdr, ["pane", "list"], signal),
	);
	// Pane rows carry no tab label, so resolve the native tab names separately:
	// an unmanaged card shows the tab it lives in instead of a blank row.
	const tabs = decodeHerdrResult(
		tabListResult,
		await call(herdr, ["tab", "list"], signal),
	);
	const workspaces = decodeHerdrResult(
		workspaceListResult,
		await call(herdr, ["workspace", "list"], signal),
	);
	const tabLabelByTab = new Map<string, string>();
	for (const tab of tabs.tabs ?? [])
		if (tab.tab_id && tab.label) tabLabelByTab.set(tab.tab_id, tab.label);
	const tabLabelByPane = new Map<string, string>();
	for (const pane of panes.panes ?? [])
		if (pane.pane_id && pane.tab_id) {
			const label = pane.tab_label ?? tabLabelByTab.get(pane.tab_id);
			if (label) tabLabelByPane.set(pane.pane_id, label);
		}

	const observations: SidebarObservation[] = [];
	for (const agent of agents.agents ?? []) {
		const paneId = agent.pane_id;
		if (!paneId) continue;
		const status = agent.agent_status;
		observations.push({
			paneId,
			status:
				status === "idle" ||
				status === "working" ||
				status === "blocked" ||
				status === "done"
					? status
					: "unknown",
			fresh: true,
		});
	}
	const unmanagedPanes: UnmanagedPane[] = [];
	for (const pane of panes.panes ?? []) {
		if (!pane.pane_id || !pane.workspace_id) continue;
		const tabLabel = tabLabelByPane.get(pane.pane_id);
		const label =
			pane.agent ?? pane.terminal_title_stripped ?? tabLabel ?? pane.pane_id;
		unmanagedPanes.push({
			paneId: pane.pane_id,
			workspaceId: pane.workspace_id,
			label,
			status: pane.agent_status ?? "unknown",
			// The tab name is only worth a row when it adds something the label
			// does not already say (a bare terminal pane is named by its tab).
			...(tabLabel && tabLabel !== label ? { tabLabel } : {}),
		});
	}
	const unmanagedWorkspaces: UnmanagedWorkspace[] = [];
	for (const workspace of workspaces.workspaces ?? [])
		if (workspace.workspace_id)
			unmanagedWorkspaces.push({
				workspaceId: workspace.workspace_id,
				label: workspace.label ?? workspace.name ?? workspace.workspace_id,
				...((workspace.status ?? workspace.agent_status)
					? { status: workspace.status ?? workspace.agent_status }
					: {}),
			});
	return { observations, unmanagedPanes, unmanagedWorkspaces };
}

/** One bounded, non-secret diagnostic sink: identical repeats collapse, so a
 * persistent Herdr failure reports once per distinct message. */
export class BoundedSidebarDiagnostics implements SidebarDiagnostics {
	private readonly seen = new Set<string>();
	constructor(private readonly sink: (message: string) => void = () => {}) {}
	report(message: string): void {
		const bounded = message.slice(0, 200);
		if (this.seen.has(bounded)) return;
		this.seen.add(bounded);
		this.sink(`sidebar presentation: ${bounded}`);
	}
}
