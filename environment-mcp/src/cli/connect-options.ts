import fs from "node:fs";
import path from "node:path";
import { loopbackBaseUrl } from "../transports/http/loopback-url.ts";

export function parseConnectOptions(args: string[]) {
	if (args[0] !== "--connect") throw new Error("Explicit bridge mode required");
	const values = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (
			!key ||
			!value ||
			!["--url", "--token-env", "--token-file"].includes(key) ||
			values.has(key)
		)
			throw new Error("Invalid bridge option");
		values.set(key, value);
	}
	const rawUrl = values.get("--url"),
		tokenEnv = values.get("--token-env"),
		tokenFile = values.get("--token-file");
	if (!rawUrl || Boolean(tokenEnv) === Boolean(tokenFile))
		throw new Error("Bridge URL and one credential source required");
	const url = new URL(rawUrl);
	if (url.pathname !== "/mcp") throw new Error("Bridge URL must target /mcp");
	const base = loopbackBaseUrl(rawUrl);
	const token = tokenEnv
		? (() => {
				if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv))
					throw new Error("Invalid bridge token reference");
				const value = process.env[tokenEnv];
				if (!value) throw new Error("Missing bridge credential");
				return value;
			})()
		: (() => {
				if (!tokenFile || !path.isAbsolute(tokenFile))
					throw new Error("Bridge token file must be absolute");
				const stat = fs.lstatSync(tokenFile);
				if (
					!stat.isFile() ||
					(stat.mode & 0o077) !== 0 ||
					stat.uid !== process.getuid?.() ||
					stat.size > 4096
				)
					throw new Error("Bridge token file is not private");
				return fs.readFileSync(tokenFile, "utf8").trim();
			})();
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
		throw new Error("Invalid bridge credential");
	return { url: `${base}/mcp`, token };
}
