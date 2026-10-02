// Dashboard agent session view for one `pi-durable` run
// (add-pi-durable-runtime, dashboard-agent-session-view). The route owns the
// `HostClient.watch()` subscription and hands each watch frame here; this
// module turns one defensively-parsed conversation snapshot into the lines the
// session modal renders. It is presentation only — no host, no I/O — so a
// shape drift in the experimental pi-durable package degrades to fewer lines
// instead of throwing in the dashboard.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and bound one line so a multi-line model answer cannot
 * push the rest of the transcript out of the fixed-height modal. */
function oneLine(value: unknown, max = 220): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Concatenate the text blocks of a serialized pi message content field (a
 * plain string for user messages, a block array for assistant/tool results). */
function contentText(content: unknown): string {
	if (typeof content === "string") return oneLine(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string")
			parts.push(block.text);
	}
	return oneLine(parts.join(" "));
}

/** A tool call's argument summary: `path`, `command`, … collapsed to one
 * short line, or nothing when the tool declares no arguments. */
function argsSummary(value: unknown): string {
	if (!isRecord(value)) return "";
	const entries = Object.entries(value);
	if (entries.length === 0) return "";
	return entries
		.slice(0, 3)
		.map(([key, entry]) => `${key}=${oneLine(String(entry), 60)}`)
		.join(" ");
}

/** Render one committed transcript entry as zero or more lines. Unknown entry
 * kinds are skipped rather than guessed at. */
function entryLines(entry: unknown): string[] {
	if (!isRecord(entry)) return [];
	const model = Array.isArray(entry.model) ? entry.model : [];
	switch (entry.kind) {
		case "pi.user":
			return model
				.map((message) => oneLine(isRecord(message) ? message.content : ""))
				.filter(Boolean)
				.map((text) => `you: ${text}`);
		case "pi.assistant": {
			const lines: string[] = [];
			for (const message of model) {
				if (!isRecord(message) || !Array.isArray(message.content)) continue;
				for (const block of message.content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string") {
						const text = oneLine(block.text);
						if (text) lines.push(`pi: ${text}`);
					} else if (
						block.type === "toolCall" &&
						typeof block.name === "string"
					) {
						const args = argsSummary(block.arguments);
						lines.push(`  • ${block.name}${args ? `(${args})` : ""}`);
					}
				}
			}
			return lines;
		}
		case "pi.tool-result":
			return model
				.map((message) => {
					if (!isRecord(message)) return "";
					const name =
						typeof message.toolName === "string" ? message.toolName : "tool";
					const status = message.isError === true ? "failed" : "done";
					const text = contentText(message.content);
					return oneLine(`  ↳ ${name} ${status}${text ? `: ${text}` : ""}`);
				})
				.filter(Boolean);
		case "pi.compaction":
			return ["— context compacted —"];
		case "pi.reset":
			return ["— context reset —"];
		default:
			return [];
	}
}

/** The live in-flight generation and running tools, which the committed
 * transcript does not carry yet. */
function liveLines(live: Record<string, unknown> | undefined): string[] {
	if (!live) return [];
	const lines: string[] = [];
	const tools = Array.isArray(live.tools) ? live.tools : [];
	for (const slot of tools) {
		if (!isRecord(slot) || slot.status === "done") continue;
		const name = typeof slot.name === "string" ? slot.name : "tool";
		// The call's arguments are already committed in the assistant entry that
		// opened this round; a running slot only adds its name, status, and the
		// output it has produced so far.
		const output = oneLine(slot.output, 120);
		lines.push(
			oneLine(`▶ ${name} ${slot.status}${output ? `: ${output}` : ""}`),
		);
	}
	const generation = isRecord(live.generation) ? live.generation : undefined;
	if (generation) {
		if (
			isRecord(generation.retry) &&
			typeof generation.retry.error === "string"
		)
			lines.push(oneLine(`… retrying: ${generation.retry.error}`));
		else if (generation.deferred) lines.push("… waiting on provider response");
		const message = isRecord(generation.message)
			? generation.message
			: undefined;
		if (message) {
			const text = contentText(message.content);
			if (text) lines.push(`pi: ${text}`);
		}
	}
	const compactions = Array.isArray(live.compactions) ? live.compactions : [];
	for (const compaction of compactions) {
		if (isRecord(compaction)) lines.push("… compacting context");
	}
	return lines;
}

/** Most recent transcript lines, bounded so the fixed-height modal keeps the
 * newest activity visible instead of clipping it. */
const MAX_TRANSCRIPT_LINES = 26;

function transcriptLines(entries: readonly unknown[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) lines.push(...entryLines(entry));
	return lines.length > MAX_TRANSCRIPT_LINES
		? lines.slice(lines.length - MAX_TRANSCRIPT_LINES)
		: lines;
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
	const running = tools.filter(
		(tool) => isRecord(tool) && tool.status === "running",
	);
	const queued = inbox && Array.isArray(inbox.items) ? inbox.items : [];
	// Plain labels, not markdown: the modal renders these lines as terminal
	// text, so emphasis markers would show up literally.
	const lines = [
		`Status: ${busy ? "working" : "idle"}`,
		...running.map(
			(tool) =>
				`Running tool: ${isRecord(tool) && typeof tool.name === "string" ? tool.name : "tool"}`,
		),
		...(queued.length > 0 ? [`Queued submissions: ${queued.length}`] : []),
		`Transcript entries: ${entries.length}`,
		"",
	];
	const body = [...transcriptLines(entries), ...liveLines(live)];
	lines.push(...(body.length > 0 ? body : ["_No activity yet._"]));
	return lines.join("\n");
}
