/** Bounded, deadline-limited request read shared by the two local transports. */
export async function boundedRequestBody(request: Request, limit: number) {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		throw new Error("Request body too large");
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing request body");
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > limit) throw new Error("Request body too large");
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
