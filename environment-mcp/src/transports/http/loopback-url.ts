/** The environment listeners bind numeric loopback only. Sharing this check keeps
 * the UI clients aligned with the server host fence. */
export function loopbackBaseUrl(raw: string) {
	const url = new URL(raw);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("UI requires an http loopback URL");
	return url.origin;
}
