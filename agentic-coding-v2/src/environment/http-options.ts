import { object, text } from "../config.ts";
export type HttpOptions = {
	method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
	headers: Record<string, string>;
	body?: string;
	followRedirects: boolean;
	authenticate: boolean;
	allowWrite: boolean;
};
export function httpOptions(raw: unknown = {}): HttpOptions {
	const data = object(raw),
		method = data.method ?? "GET";
	if (
		Object.keys(data).some(
			(key) =>
				![
					"method",
					"headers",
					"body",
					"allowWrite",
					"followRedirects",
					"authenticate",
				].includes(key),
		)
	)
		throw new Error("Unknown HTTP request option");
	if (
		!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
			String(method),
		)
	)
		throw new Error("Unsupported endpoint HTTP method");
	for (const field of ["allowWrite", "followRedirects", "authenticate"])
		if (data[field] !== undefined && typeof data[field] !== "boolean")
			throw new Error("HTTP permission flags must be booleans");
	const allowWrite = data.allowWrite === true;
	if (!["GET", "HEAD", "OPTIONS"].includes(String(method)) && !allowWrite)
		throw new Error(
			"HTTP writes require explicit allowWrite and exact human approval",
		);
	if (
		data.body !== undefined &&
		(typeof data.body !== "string" ||
			Buffer.byteLength(data.body) > 16384 ||
			["GET", "HEAD"].includes(String(method)))
	)
		throw new Error(
			"HTTP request bodies require a body-capable method and at most 16 KiB",
		);
	const entries = Object.entries(object(data.headers ?? {}));
	if (entries.length > 16) throw new Error("At most 16 explicit HTTP headers");
	const headers: Record<string, string> = {};
	for (const [key, value] of entries) {
		const name = key.toLowerCase();
		if (
			![
				"accept",
				"content-type",
				"if-match",
				"if-none-match",
				"idempotency-key",
			].includes(name) ||
			Object.hasOwn(headers, name) ||
			typeof value !== "string" ||
			value.length > 1024 ||
			/[^\x20-\x7e]/.test(value)
		)
			throw new Error(
				"Only bounded printable accept/content-type/conditional/idempotency headers are allowed; credentials and transport headers require server-owned handling",
			);
		headers[name] = value;
	}
	if (Buffer.byteLength(JSON.stringify(headers)) > 4096)
		throw new Error("HTTP request headers exceed 4 KiB");
	return {
		method: method as HttpOptions["method"],
		headers,
		...(data.body === undefined ? {} : { body: data.body as string }),
		followRedirects: data.followRedirects === true,
		authenticate: data.authenticate === true,
		allowWrite,
	};
}
export type EndpointAuth =
	| { type: "bearer"; variable: string }
	| { type: "basic"; usernameVariable: string; passwordVariable: string };
export function readEndpointAuth(
	raw: unknown,
	endpoints: Record<string, string>,
	secretRefs: Record<string, string>,
): Record<string, EndpointAuth> {
	return Object.fromEntries(
		Object.entries(object(raw ?? {})).map(([endpoint, entry]) => {
			if (
				!Object.hasOwn(endpoints, endpoint) ||
				new URL(endpoints[endpoint] ?? "").protocol !== "https:"
			)
				throw new Error(
					"Endpoint authentication requires a declared HTTPS endpoint",
				);
			const data = object(entry),
				fields =
					data.type === "bearer"
						? ["type", "variable"]
						: data.type === "basic"
							? ["type", "usernameVariable", "passwordVariable"]
							: [];
			if (
				!fields.length ||
				Object.keys(data).some((key) => !fields.includes(key))
			)
				throw new Error(
					"Endpoint authentication requires bearer/basic secret-variable references",
				);
			const variable = (key: string) => {
				const name = text(data[key], "endpoint authentication variable", 128);
				if (!Object.hasOwn(secretRefs, name))
					throw new Error(
						"Endpoint authentication variables must be declared secretRefs",
					);
				return name;
			};
			const auth: EndpointAuth =
				data.type === "bearer"
					? { type: "bearer", variable: variable("variable") }
					: {
							type: "basic",
							usernameVariable: variable("usernameVariable"),
							passwordVariable: variable("passwordVariable"),
						};
			return [endpoint, auth];
		}),
	);
}
/** Private derived credentials are never included in the persisted plan or tool result. */
export function authentication(
	auth: EndpointAuth,
	env: Record<string, string>,
): string {
	if (auth.type === "bearer") {
		const token = env[auth.variable];
		if (!token || token.length > 4096 || !/^[-A-Za-z0-9._~+/]+=*$/.test(token))
			throw new Error("Invalid referenced endpoint bearer credential");
		return `Bearer ${token}`;
	}
	const user = env[auth.usernameVariable],
		password = env[auth.passwordVariable];
	if (
		!user ||
		!password ||
		user.length > 256 ||
		password.length > 4096 ||
		/[\r\n:]/.test(user) ||
		/[\r\n]/.test(password)
	)
		throw new Error("Invalid referenced endpoint Basic credentials");
	const header = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
	if (header.length > 8192)
		throw new Error(
			"Referenced endpoint Basic credentials exceed the private header bound",
		);
	return header;
}
