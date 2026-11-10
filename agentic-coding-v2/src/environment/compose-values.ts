import { object } from "../config.ts";

/** Compose command strings are argv, not implicit shell scripts. No interpolation,
 * command substitution or glob evaluation occurs. Unclosed quotes fail closed. */
export function composeArgv(raw: unknown) {
	if (typeof raw !== "string") return raw;
	if (raw.length > 16000 || /[\0\r\n]/.test(raw))
		throw new Error("Invalid Compose command string");
	const words: string[] = [];
	let word = "",
		quote = "",
		escaped = false,
		started = false;
	for (const char of raw) {
		if (escaped) {
			if (quote === '"' && !['"', "\\", "$", "`"].includes(char)) word += "\\";
			word += char;
			escaped = false;
			started = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
			started = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		word += char;
		started = true;
	}
	if (escaped || quote) throw new Error("Unclosed Compose command quoting");
	if (started) words.push(word);
	return words;
}
export function composeEnvironment(raw: unknown): Record<string, unknown> {
	if (!Array.isArray(raw)) return object(raw ?? {});
	if (raw.length > 100) throw new Error("Too many Compose environment entries");
	const entries: [string, string][] = raw.map((entry) => {
		if (typeof entry !== "string" || !entry.includes("="))
			throw new Error(
				"Compose environment arrays require explicit KEY=value; inheritance is refused",
			);
		const split = entry.indexOf("=");
		return [entry.slice(0, split), entry.slice(split + 1)];
	});
	if (new Set(entries.map(([key]) => key)).size !== entries.length)
		throw new Error("Repeated Compose environment key");
	return Object.fromEntries(entries);
}
export function composePort(raw: unknown) {
	if (typeof raw !== "string") return raw;
	const match =
		/^(?:(\[[a-fA-F0-9:]+\]|[0-9.]+):)?([0-9]+):([0-9]+)(?:\/(tcp|udp))?$/.exec(
			raw,
		);
	if (!match)
		throw new Error(
			"Compose short ports require explicit host and container ports; ranges and random ports are refused",
		);
	return {
		host_ip: match[1]?.replace(/^\[|\]$/g, "") ?? "127.0.0.1",
		published: Number(match[2]),
		target: Number(match[3]),
		protocol: match[4] ?? "tcp",
	};
}
export function composeMount(raw: unknown) {
	if (typeof raw !== "string") return raw;
	const parts = raw.split(":");
	if (
		parts.length < 2 ||
		parts.length > 3 ||
		(parts[2] !== undefined && parts[2] !== "ro" && parts[2] !== "rw")
	)
		throw new Error("Compose mounts require explicit source:target[:ro|rw]");
	return {
		type:
			parts[0]?.startsWith(".") || parts[0]?.startsWith("/")
				? "bind"
				: "volume",
		source: parts[0],
		target: parts[1],
		read_only: parts[2] === "ro",
	};
}
