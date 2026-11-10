import fs from "node:fs";
import path from "node:path";
import { object } from "../config.ts";
import type { Plan } from "./model.ts";
import type { processEnvironment } from "./shell.ts";

export type BuildSecret =
	| { env: string }
	| { file: string }
	| {
			template: string;
			refs: Record<string, string>;
			encoding: "xml" | "text";
	  };
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function readBuildSecrets(raw: unknown): Record<string, BuildSecret> {
	const entries = Object.entries(object(raw ?? {}));
	if (entries.length > 32)
		throw new Error("At most 32 build secrets are supported");
	return Object.fromEntries(
		entries.map<[string, BuildSecret]>(([id, raw]) => {
			if (!/^[a-z][a-z0-9_-]{0,62}$/.test(id))
				throw new Error("Invalid build secret ID");
			const value = object(raw),
				keys = Object.keys(value).sort().join(",");
			if (
				keys === "env" &&
				typeof value.env === "string" &&
				envName.test(value.env)
			)
				return [id, { env: value.env }];
			if (
				keys === "file" &&
				typeof value.file === "string" &&
				path.isAbsolute(value.file) &&
				value.file.length <= 4096 &&
				!/[\0\r\n]/.test(value.file)
			)
				return [id, { file: value.file }];
			if (
				keys === "encoding,refs,template" &&
				typeof value.template === "string" &&
				Buffer.byteLength(value.template) <= 65536 &&
				!value.template.includes("\0") &&
				["xml", "text"].includes(String(value.encoding))
			) {
				const refs = object(value.refs);
				if (
					Object.keys(refs).length > 32 ||
					Object.entries(refs).some(
						([key, ref]) =>
							!envName.test(key) ||
							typeof ref !== "string" ||
							!envName.test(ref),
					)
				)
					throw new Error("Invalid build template references");
				return [
					id,
					{
						template: value.template,
						refs: refs as Record<string, string>,
						encoding: value.encoding as "xml" | "text",
					},
				];
			}
			throw new Error(
				"Build secrets require one explicit env/file reference or an encoded template with declared references",
			);
		}),
	);
}
export function buildReferenceKeys(secret: BuildSecret) {
	return "env" in secret
		? [secret.env]
		: "refs" in secret
			? Object.values(secret.refs)
			: [];
}
function fileSecret(file: string) {
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
			throw new Error(
				"Build secret file must be a regular, nonlinked file of at most 64 KiB",
			);
		const bytes = Buffer.alloc(65537);
		let size = 0;
		while (size < bytes.length) {
			const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 65536) throw new Error("Build secret file exceeds 64 KiB");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, size),
		);
	} finally {
		fs.closeSync(fd);
	}
}
function xml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
/** Startup-only credentials remain in the CLI environment, never build args,
 * context files, approval records or serialized plans. BuildKit mounts them as
 * secrets; a configured Dockerfile is still approved code, not a sandbox. */
export function freezeBuildSecrets(
	plan: Plan,
	frozen: ReturnType<typeof processEnvironment>,
) {
	if (plan.action !== "build")
		return { environment: frozen, arguments: [] as string[] };
	const env: Record<string, string> = { ...frozen.env, DOCKER_BUILDKIT: "1" },
		values: string[] = [],
		args: string[] = [];
	for (const [index, [id, secret]] of Object.entries(
		plan.container?.buildSecrets ?? {},
	).entries()) {
		let value: string;
		if ("env" in secret) value = env[secret.env] ?? "";
		else if ("file" in secret) {
			value = fileSecret(secret.file);
			for (const line of value.split(/\r?\n/)) {
				const split = line.indexOf("=");
				if (split >= 0)
					values.push(
						line
							.slice(split + 1)
							.trim()
							.replace(/^['"]|['"]$/g, ""),
					);
			}
		} else {
			if (
				secret.template
					.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "")
					.includes("${")
			)
				throw new Error("Unsupported build template expression");
			value = secret.template.replace(
				/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
				(_match, key: string) => {
					const ref = secret.refs[key],
						resolved = ref ? env[ref] : undefined;
					if (resolved === undefined)
						throw new Error("Missing declared build template reference");
					values.push(resolved, xml(resolved));
					return secret.encoding === "xml" ? xml(resolved) : resolved;
				},
			);
		}
		if (!value || value.includes("\0") || Buffer.byteLength(value) > 65536)
			throw new Error("Invalid or missing build secret input");
		const key = `ACV2_BUILD_SECRET_${index}`;
		env[key] = value;
		values.push(value);
		args.push("--secret", `id=${id},env=${key}`);
	}
	const hidden = [
		...new Set(
			values.flatMap((value) => [value, ...value.split(/\r?\n/)]),
		).values(),
	]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
	return {
		environment: {
			...frozen,
			env: { ...frozen.env, ...env },
			redact: (value: string) =>
				frozen.redact(
					hidden.reduce(
						(text, secret) => text.replaceAll(secret, "[REDACTED]"),
						value,
					),
				),
		},
		arguments: args,
	};
}
