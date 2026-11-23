import { loopbackBaseUrl } from "../transports/http/loopback-url.ts";

export function parseUiOptions(args: string[]) {
	if (args[0] !== "--ui") throw new Error("Explicit UI mode required");
	const values = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (
			!key ||
			!value ||
			!["--url", "--token-env", "--title"].includes(key) ||
			values.has(key)
		)
			throw new Error("Invalid UI option");
		values.set(key, value);
	}
	const rawUrl = values.get("--url"),
		tokenEnv = values.get("--token-env"),
		title = values.get("--title");
	if (!rawUrl || !tokenEnv)
		throw new Error("UI URL and token reference required");
	if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv))
		throw new Error("Invalid UI token reference");
	const token = process.env[tokenEnv];
	if (!token) throw new Error("Missing UI credential");
	return {
		url: loopbackBaseUrl(rawUrl),
		token,
		title,
	};
}
