import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { loopbackBaseUrl } from "../transports/http/loopback-url.ts";

const accessSchema = z.strictObject({
	url: z.string().min(1).max(4096),
	token: z.string().min(32).max(128),
});

export function parseOperatorUiOptions(args: string[]) {
	if (args[0] !== "--operator-ui")
		throw new Error("Explicit operator UI mode required");
	const values = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (
			!key ||
			!value ||
			!["--access-file", "--url", "--token-env", "--title"].includes(key) ||
			values.has(key)
		)
			throw new Error("Invalid operator UI option");
		values.set(key, value);
	}
	const accessFile = values.get("--access-file"),
		rawUrl = values.get("--url"),
		tokenEnv = values.get("--token-env"),
		title = values.get("--title");
	let token: string;
	let url: string;
	if (accessFile) {
		if (!path.isAbsolute(accessFile) || rawUrl || tokenEnv)
			throw new Error(
				"Operator access file must be the only credential source",
			);
		const stat = fs.lstatSync(accessFile);
		if (
			!stat.isFile() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			stat.size > 4096
		)
			throw new Error("Operator access file is not private");
		const access = accessSchema.parse(
			JSON.parse(fs.readFileSync(accessFile, "utf8")),
		);
		url = loopbackBaseUrl(access.url);
		token = access.token;
	} else {
		if (!rawUrl || !tokenEnv)
			throw new Error("Operator URL and token reference required");
		if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv))
			throw new Error("Invalid operator token reference");
		const value = process.env[tokenEnv];
		if (!value) throw new Error("Missing operator credential");
		url = loopbackBaseUrl(rawUrl);
		token = value;
	}
	return { url, token, title };
}
