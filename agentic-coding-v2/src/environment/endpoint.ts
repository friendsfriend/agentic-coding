import { object, text } from "../config.ts";
import type { EndpointCa } from "./endpoint-ca.ts";
import type { EndpointAuth, HttpOptions } from "./http-options.ts";
import type { ReferenceScope } from "./reference-scope.ts";
export type EndpointRequest = {
	run: string;
	app: string;
	endpoint: string;
	url: string;
	ca?: EndpointCa;
	http?: HttpOptions;
	authentication?: EndpointAuth;
	/** Referenced-lifetime only: exact root generation and its prerequisites. */
	root?: ReferenceScope;
};
export function localEndpoint(raw: string) {
	const url = new URL(raw);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		Number(url.port || (url.protocol === "https:" ? 443 : 80)) < 1
	)
		throw new Error(
			"Endpoints require an HTTP/HTTPS numeric-loopback origin without credentials",
		);
	return url;
}
export function readEndpoints(raw: unknown): Record<string, string> {
	const entries = Object.entries(object(raw ?? {}));
	if (entries.length > 16)
		throw new Error("At most 16 named endpoints are supported");
	return Object.fromEntries(
		entries.map(([name, value]) => {
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
				throw new Error("Invalid endpoint name");
			const url = localEndpoint(text(value, "local endpoint URL", 2048));
			if (url.href.length > 4096 || url.search || url.hash)
				throw new Error(
					"Endpoint definitions cannot contain queries or fragments",
				);
			return [name, url.href];
		}),
	);
}
export function endpointUrl(base: string, rawPath: string) {
	const input = text(rawPath, "endpoint request path", 2048);
	if (
		!input.startsWith("/") ||
		input.startsWith("//") ||
		input.includes("\\") ||
		[...input].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	)
		throw new Error(
			"Endpoint requests require a local absolute path, not a URL",
		);
	const origin = localEndpoint(base),
		url = new URL(
			`${origin.pathname.replace(/\/$/, "")}${input}`,
			origin.origin,
		);
	if (
		url.href.length > 4096 ||
		url.origin !== origin.origin ||
		url.hash ||
		url.username ||
		url.password
	)
		throw new Error(
			"Endpoint request cannot leave its configured origin or contain a fragment",
		);
	return url.href;
}
