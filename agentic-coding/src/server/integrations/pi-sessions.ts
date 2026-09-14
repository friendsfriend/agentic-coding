// Pi session discovery (`port-git-providers-and-ai-to-bun`, task 4.1), ported
// from `server/pkg/server/handlers_agent.go`.
//
// The parse is bounded and never executes file content: a line above 1 MB stops
// that file's parse, a malformed line is skipped, a file without a session
// header is skipped, and a whole-listing failure is reported as an empty list
// rather than an error.
//
// Two deliberate differences: the groups are sorted by name (the Go grouping
// iterated a map, so its order was incidental) and the file list is sorted by
// name, so a listing is reproducible on every filesystem.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Bounded JSONL line length; a longer line abandons the rest of that file. */
export const MAX_SESSION_LINE_BYTES = 1024 * 1024;
/** Go's zero `time.Time` in Unix milliseconds. */
const ZERO_TIME_MS = -62135596800000;

export interface AgentSessionInfo {
	id: string;
	title: string;
	timeCreated: number;
	timeUpdated: number;
}

export interface AgentGroup {
	name: string;
	model: string;
	sessions: AgentSessionInfo[];
}

/** Session directory root, honouring `PI_CODING_AGENT_DIR`. */
export function piSessionsBase(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir =
		env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR !== ""
			? env.PI_CODING_AGENT_DIR
			: path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "sessions");
}

/** Whether an executable is resolvable on PATH without a shell. */
export function hasExecutable(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const pathValue = env.PATH ?? "";
	for (const dir of pathValue.split(path.delimiter)) {
		if (dir === "") continue;
		try {
			fs.accessSync(path.join(dir, name), fs.constants.X_OK);
			return true;
		} catch {
			// Not here; keep looking.
		}
	}
	return false;
}

/** Every session group, or an empty list when Pi is absent or the directory
 * does not exist yet. */
export function queryPiSessions(
	options: { readonly env?: NodeJS.ProcessEnv; readonly hasPi?: boolean } = {},
): AgentGroup[] {
	const env = options.env ?? process.env;
	const hasPi = options.hasPi ?? hasExecutable("pi", env);
	if (!hasPi) return [];
	const base = piSessionsBase(env);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}

	const groups = new Map<string, AgentSessionInfo[]>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dirPath = path.join(base, entry.name);
		let files: string[];
		try {
			files = fs
				.readdirSync(dirPath)
				.filter((name) => {
					if (!name.endsWith(".jsonl")) return false;
					try {
						return !fs.statSync(path.join(dirPath, name)).isDirectory();
					} catch {
						return false;
					}
				})
				.sort();
		} catch {
			continue;
		}
		for (const name of files) {
			const filePath = path.join(dirPath, name);
			const parsed = parsePiSessionFile(filePath);
			if (!parsed) continue;
			const baseName = path.basename(parsed.cwd);
			const groupName =
				baseName === "." || baseName === "" ? entry.name : baseName;
			const sessions = groups.get(groupName) ?? [];
			sessions.push(parsed.session);
			groups.set(groupName, sessions);
		}
	}

	return [...groups.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([name, sessions]) => ({ name, model: "", sessions }));
}

interface SessionHeader {
	timestamp: string;
	cwd: string;
}

/** Parse one session file. `undefined` means the file has no session header and
 * is skipped. */
export function parsePiSessionFile(
	filePath: string,
): { session: AgentSessionInfo; cwd: string } | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const header: SessionHeader = { timestamp: "", cwd: "" };
	let firstUserText = "";
	const lines = content.split("\n");
	for (const line of lines) {
		if (line === "") continue;
		// A line beyond the read bound abandons the rest of the file, exactly
		// like the bounded scanner the Go reader used.
		if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) break;
		let peek: { type?: unknown };
		try {
			peek = JSON.parse(line);
		} catch {
			continue;
		}
		const type = typeof peek.type === "string" ? peek.type : "";
		if (type === "session") {
			try {
				const parsed = JSON.parse(line) as {
					timestamp?: unknown;
					cwd?: unknown;
				};
				if (typeof parsed.timestamp === "string")
					header.timestamp = parsed.timestamp;
				if (typeof parsed.cwd === "string") header.cwd = parsed.cwd;
			} catch {
				// A partially readable header keeps whatever was already set.
			}
		} else if (type === "message" && firstUserText === "") {
			const text = firstUserMessageText(line);
			if (text !== "") firstUserText = text;
		}
		if (header.timestamp !== "" && firstUserText !== "") break;
	}

	if (header.timestamp === "") return undefined;

	const parsedTime = Date.parse(header.timestamp);
	const timeMs = Number.isNaN(parsedTime) ? ZERO_TIME_MS : parsedTime;
	let title = firstUserText;
	if (title === "") title = formatSessionTime(timeMs);
	else if (Array.from(title).length > 60)
		title = `${Array.from(title).slice(0, 57).join("")}...`;
	title = title.split(/\s+/u).filter(Boolean).join(" ");

	return {
		session: {
			id: filePath,
			title,
			timeCreated: timeMs,
			timeUpdated: timeMs,
		},
		cwd: header.cwd,
	};
}

function firstUserMessageText(line: string): string {
	let parsed: {
		message?: { role?: unknown; content?: unknown };
	};
	try {
		parsed = JSON.parse(line);
	} catch {
		return "";
	}
	const message = parsed.message;
	if (message?.role !== "user") return "";
	if (!Array.isArray(message.content)) return "";
	for (const part of message.content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text !== ""
		)
			return (part as { text: string }).text;
	}
	return "";
}

/** Go's `2006-01-02 15:04` for a timestamp in milliseconds. */
function formatSessionTime(timeMs: number): string {
	const date = new Date(timeMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(
		date.getUTCMonth() + 1,
	)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(
		date.getUTCMinutes(),
	)}`;
}
