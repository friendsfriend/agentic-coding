import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const envByteLimit = 64 * 1024;

export type SecretSource = { get(reference: string): string | undefined };

/** Same mechanism as the v1/v2 environments UI: the configuration root's `.env`
 * is parsed once at startup, process environment is the fallback, and only
 * explicitly declared references are resolved at dispatch. Values stay in this
 * private source; they are never returned by a tool or written to state. */
export function loadSecretSource(configDir: string): SecretSource {
	const file = path.join(configDir, ".env");
	let fileValues: Record<string, string> = {};
	if (fs.existsSync(file)) {
		const fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.size > envByteLimit)
				throw new Error("Invalid environment file");
			const bytes = Buffer.alloc(envByteLimit + 1);
			let length = 0;
			while (length < bytes.length) {
				const size = fs.readSync(
					fd,
					bytes,
					length,
					bytes.length - length,
					null,
				);
				if (!size) break;
				length += size;
			}
			if (length > envByteLimit) throw new Error("Invalid environment file");
			const parsed = parseEnv(bytes.subarray(0, length).toString("utf8"));
			fileValues = Object.fromEntries(
				Object.entries(parsed).filter(
					([key, value]) =>
						/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
						typeof value === "string" &&
						!value.includes("\0") &&
						value.length <= 16000,
				),
			) as Record<string, string>;
		} finally {
			fs.closeSync(fd);
		}
	}
	return {
		get(reference) {
			return fileValues[reference] ?? process.env[reference];
		},
	};
}

/** Explicit provider-token fallback file. The path may be a symlink chosen by
 * the operator; its canonical target must still be a regular private file. */
export function loadSecretFile(file: string): SecretSource {
	if (!path.isAbsolute(file)) throw new Error("Secret file must be absolute");
	const canonical = fs.realpathSync(file);
	const stat = fs.lstatSync(canonical);
	if (
		!stat.isFile() ||
		stat.size > envByteLimit ||
		(stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.()
	)
		throw new Error("Invalid secret file");
	const fd = fs.openSync(
		canonical,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			(opened.mode & 0o077) !== 0
		)
			throw new Error("Invalid secret file");
		const bytes = Buffer.alloc(envByteLimit + 1);
		let length = 0;
		while (length < bytes.length) {
			const size = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (!size) break;
			length += size;
		}
		if (length > envByteLimit) throw new Error("Invalid secret file");
		const parsed = parseEnv(bytes.subarray(0, length).toString("utf8"));
		const values = Object.fromEntries(
			Object.entries(parsed).filter(
				([key, value]) =>
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
					typeof value === "string" &&
					!value.includes("\0") &&
					value.length <= 16000,
			),
		) as Record<string, string>;
		return {
			get(reference) {
				return values[reference] ?? process.env[reference];
			},
		};
	} finally {
		fs.closeSync(fd);
	}
}

/** Resolve only declared references. A missing value refuses before issuance. */
export function resolveReferences(
	secrets: SecretSource,
	refs: Record<string, string>,
) {
	const values: Record<string, string> = {};
	for (const [key, reference] of Object.entries(refs)) {
		const value = secrets.get(reference);
		if (!value) throw new Error("secret-reference-unavailable");
		values[key] = value;
	}
	return values;
}

/** Substitute only declared `${REF}` placeholders; an unknown placeholder or a
 * missing reference refuses rather than writing a partial secret file. */
export function renderTemplate(
	template: string,
	secrets: SecretSource,
	refs: Record<string, string>,
) {
	let rendered = template;
	for (const [placeholder, reference] of Object.entries(refs)) {
		const value = secrets.get(reference);
		if (!value) throw new Error("secret-reference-unavailable");
		rendered = rendered.replaceAll(`\${${placeholder}}`, value);
	}
	if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rendered))
		throw new Error("unresolved-template-reference");
	return rendered;
}
