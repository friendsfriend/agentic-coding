import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest, object, text } from "../config.ts";
import { contained } from "../git.ts";
export type EndpointCa = { file: string; digest: string };
export function readEndpointCaRefs(
	raw: unknown,
	endpoints: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(object(raw ?? {})).map(([name, value]) => {
			if (
				!Object.hasOwn(endpoints, name) ||
				new URL(endpoints[name] ?? "").protocol !== "https:"
			)
				throw new Error(
					"Endpoint CA references require a declared HTTPS endpoint",
				);
			const file = text(value, "public endpoint CA file", 4096);
			if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
				throw new Error(
					"Endpoint CA references must stay inside the configuration directory",
				);
			return [name, file];
		}),
	);
}
function readCa(configDir: string, relative: string) {
	const file = contained(fs.realpathSync(configDir), relative),
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size < 1 || stat.size > 65536)
			throw new Error(
				"Endpoint CA must be a bounded regular public certificate file",
			);
		const buffer = Buffer.alloc(65537),
			size = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (size !== stat.size)
			throw new Error("Endpoint CA changed while reading");
		const bytes = buffer.subarray(0, size),
			pem = bytes.toString("utf8");
		if (
			!/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
				pem,
			) ||
			!new X509Certificate(bytes).ca
		)
			throw new Error(
				"Only one PEM public CA certificate is supported; keys and bundles are refused",
			);
		return bytes;
	} finally {
		fs.closeSync(fd);
	}
}
export function prepareEndpointCa(configDir: string, file: string): EndpointCa {
	return { file, digest: digest(readCa(configDir, file)) };
}
export function loadEndpointCa(configDir: string, approved: EndpointCa) {
	const bytes = readCa(configDir, approved.file);
	if (digest(bytes) !== approved.digest)
		throw new Error(
			"Approved endpoint CA source changed; request was not sent",
		);
	return bytes;
}
