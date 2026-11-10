import net from "node:net";

export function readReadyUrl(raw: unknown) {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || raw.length > 4096)
		throw new Error("Invalid shell readiness URL");
	const url = new URL(raw);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error(
			"Shell readiness requires an explicit IP-loopback HTTP(S) URL without credentials or fragments",
		);
	return url.href;
}
/** Approved startup only. Refuse an occupied readiness port instead of treating
 * an existing server as this child. The OS does not provide atomic bind transfer
 * to arbitrary commands; child survival and this pre-check are not a sandbox. */
export async function assertReadyPortAvailable(value: string) {
	const url = new URL(value);
	await new Promise<void>((resolve, reject) => {
		const server = net.createServer();
		server.once("error", () =>
			reject(
				new Error(
					"Shell readiness port is already occupied or unavailable; no existing server was adopted",
				),
			),
		);
		server.listen(
			{
				host: url.hostname.replace(/^\[|\]$/g, ""),
				port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
				exclusive: true,
			},
			() =>
				server.close((error) =>
					error
						? reject(new Error("Shell readiness pre-check cleanup failed"))
						: resolve(),
				),
		);
	});
}
export async function shellReady(value: string, signal?: AbortSignal) {
	try {
		const response = await fetch(value, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(500),
				...(signal ? [signal] : []),
			]),
		});
		try {
			return response.status >= 200 && response.status < 400;
		} finally {
			await response.body?.cancel();
		}
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}
