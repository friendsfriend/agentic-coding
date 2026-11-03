import { request, STATUS_CODES } from "node:http";
import { localEndpoint } from "./endpoint.ts";
/** Direct numeric-loopback HTTP only: no proxy, cookies, credentials or redirects. */
export function endpointGet(
	address: string,
	redact: (value: string) => string,
	signal?: AbortSignal,
) {
	return new Promise<{
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		bodyFormat: "text" | "omitted";
		bytes: number;
		truncated: boolean;
		url: string;
	}>((resolve, reject) => {
		signal?.throwIfAborted();
		const url = localEndpoint(address),
			chunks: Buffer[] = [];
		let bytes = 0,
			settled = false;
		const finish = (error: boolean, result?: Parameters<typeof resolve>[0]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error || !result)
				reject(new Error("Local endpoint request failed or was interrupted"));
			else resolve(result);
		};
		const client = request(
			{
				protocol: "http:",
				hostname: url.hostname.replace(/^\[|\]$/g, ""),
				port: url.port || 80,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				agent: false,
				maxHeaderSize: 16384,
				headers: { accept: "application/json, text/plain, */*" },
			},
			(response) => {
				const headers: Record<string, string> = {};
				for (const name of ["content-type", "content-length", "location"]) {
					const value = response.headers[name];
					if (typeof value === "string")
						headers[name] = redact(value).slice(0, 512);
				}
				let truncated = false;
				const done = () => {
					if (settled) return;
					const text =
						/^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)(?:;|$))/i.test(
							String(response.headers["content-type"] ?? ""),
						) && !response.headers["content-encoding"];
					const raw = Buffer.concat(chunks).toString("utf8");
					// A source cap can bisect a literal secret: withhold the incomplete final
					// line before redaction, rather than returning a secret prefix.
					const complete = truncated
						? raw.slice(0, raw.lastIndexOf("\n") + 1)
						: raw;
					let body = text
						? `${redact(complete)}${truncated ? "\n[incomplete final line omitted at source cap]" : ""}`
						: "[non-text or encoded response omitted]";
					if (JSON.stringify(body).length > 24000) {
						body = `${body.slice(0, 3990)}\n[truncated]`;
						truncated = true;
					}
					finish(false, {
						status: response.statusCode ?? 0,
						statusText: STATUS_CODES[response.statusCode ?? 0] ?? "",
						headers,
						body,
						bodyFormat: text ? "text" : "omitted",
						bytes,
						truncated,
						url: address,
					});
				};
				response.on("data", (chunk: Buffer) => {
					if (settled) return;
					const remaining = 65536 - bytes;
					chunks.push(chunk.subarray(0, remaining));
					bytes += Math.min(chunk.length, remaining);
					if (chunk.length > remaining) {
						truncated = true;
						done();
						response.destroy();
					}
				});
				response.on("end", done);
				response.on("error", () => finish(true));
				response.on("aborted", () => finish(true));
			},
		);
		const abort = () => {
			client.destroy();
			finish(true);
		};
		const timer = setTimeout(abort, 10000);
		signal?.addEventListener("abort", abort, { once: true });
		client.on("error", () => finish(true));
		if (signal?.aborted) abort();
		else client.end();
	});
}
