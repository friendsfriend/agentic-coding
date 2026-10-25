/** Read the owner-scoped action stream. Backpressure reaches the reader while
 * the tool publishes a snapshot; final output is returned, never appended twice. */
export async function readActionProgress(
	response: Response,
	onProgress: (value: unknown) => Promise<void>,
): Promise<unknown> {
	if (!response.body) throw new Error("Action stream has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let result: unknown;
	let completed = false;
	const line = async (text: string) => {
		if (!text.trim()) return;
		if (text.length > 1_000_000)
			throw new Error("Action stream frame exceeds its bound");
		if (completed) throw new Error("Action stream continued after its result");
		const frame = JSON.parse(text) as {
			type?: string;
			value?: unknown;
			error?: { code?: string; message?: string };
		};
		if (frame.type === "progress") await onProgress(frame.value);
		else if (frame.type === "result") {
			result = frame.value;
			completed = true;
		} else if (frame.type === "error")
			throw new Error(
				`${frame.error?.code ?? "action-failed"}: ${frame.error?.message ?? "Action failed"}`,
			);
		else throw new Error("Invalid action stream frame");
	};
	try {
		while (true) {
			const chunk = await reader.read();
			pending += decoder.decode(chunk.value, { stream: !chunk.done });
			let end = pending.indexOf("\n");
			while (end >= 0) {
				await line(pending.slice(0, end));
				pending = pending.slice(end + 1);
				end = pending.indexOf("\n");
			}
			if (pending.length > 1_000_000)
				throw new Error("Action stream frame exceeds its bound");
			if (chunk.done) break;
		}
		await line(pending);
		if (!completed) throw new Error("Action stream ended before its result");
		return result;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
