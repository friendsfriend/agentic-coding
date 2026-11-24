import fs from "node:fs";
import type { Executable } from "../domain/execution.ts";
import type { SecretSource } from "./secrets.ts";

/** File-based build credentials follow v1/v2: regular nonlinked file, bounded,
 * read without following symlinks, never serialized into an execution plan. */
export function readBuildSecretFile(file: string) {
	if (!file.startsWith("/") || /[\0\r\n]/.test(file))
		throw new Error("build-secret-file-invalid");
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
			throw new Error("build-secret-file-invalid");
		const bytes = Buffer.alloc(65537);
		let size = 0;
		while (size < bytes.length) {
			const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 65536) throw new Error("build-secret-file-invalid");
		const value = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, size),
		);
		if (!value || value.includes("\0"))
			throw new Error("build-secret-file-invalid");
		return value;
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

function renderBuildSecretTemplate(
	template: string,
	refs: Record<string, string>,
	encoding: "xml" | "text",
	source: SecretSource,
) {
	let rendered = template;
	for (const [placeholder, reference] of Object.entries(refs)) {
		const value = source.get(reference);
		if (!value) throw new Error("secret-reference-unavailable");
		rendered = rendered.replaceAll(
			`\${${placeholder}}`,
			encoding === "xml" ? xml(value) : value,
		);
	}
	if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rendered))
		throw new Error("unresolved-template-reference");
	return rendered;
}

export function resolveBuildSecrets(
	secrets: Extract<Executable, { kind: "docker-build" }>["secrets"],
	source: SecretSource,
) {
	return Object.fromEntries(
		secrets.map((secret) => {
			if (secret.kind === "template")
				return [
					secret.id,
					renderBuildSecretTemplate(
						secret.template,
						secret.refs,
						secret.encoding,
						source,
					),
				];
			if (secret.kind === "file")
				return [secret.id, readBuildSecretFile(secret.file)];
			const value = source.get(secret.env);
			if (!value) throw new Error("secret-reference-unavailable");
			return [secret.id, value];
		}),
	);
}

/** Values that must never appear in build output or a receipt. */
export function buildSecretRedactionValues(
	secrets: Extract<Executable, { kind: "docker-build" }>["secrets"],
	source: SecretSource,
) {
	const values: string[] = [];
	for (const secret of secrets) {
		if (secret.kind === "template") {
			for (const reference of Object.values(secret.refs)) {
				const value = source.get(reference);
				if (value) values.push(value, xml(value));
			}
		} else if (secret.kind === "env") {
			const value = source.get(secret.env);
			if (value) values.push(value);
		} else {
			try {
				const value = readBuildSecretFile(secret.file);
				values.push(value);
				for (const line of value.split(/\r?\n/)) {
					const split = line.indexOf("=");
					if (split >= 0) values.push(line.slice(split + 1).trim());
				}
			} catch {
				// Redaction is best effort; the build itself refuses an unreadable file.
			}
		}
	}
	return values.filter(Boolean);
}
