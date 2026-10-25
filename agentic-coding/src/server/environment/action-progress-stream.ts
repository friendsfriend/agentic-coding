/** Bounded progress transport: retain at most one queued and one latest
 * snapshot, plus the terminal result. Command output itself remains in the
 * action engine's bounded result/log. Slow clients cannot grow this queue. */
export function actionProgressResponse(
	run: (
		publish: (value: unknown) => void,
		signal: AbortSignal,
	) => Promise<unknown>,
	redact: (value: unknown) => unknown,
	errorValue: (error: unknown) => { code: string; message: string },
): Response {
	const abort = new AbortController();
	const encoder = new TextEncoder();
	let pending: unknown;
	let terminal: unknown;
	let completed = false;
	let closed = false;
	let flush = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			flush = () => {
				if (closed) return;
				if ((controller.desiredSize ?? 0) > 0 && pending !== undefined) {
					const value = pending;
					pending = undefined;
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify(redact({ type: "progress", value }))}\n`,
						),
					);
				}
				if ((controller.desiredSize ?? 0) > 0 && terminal !== undefined) {
					const value = terminal;
					terminal = undefined;
					controller.enqueue(
						encoder.encode(`${JSON.stringify(redact(value))}\n`),
					);
				}
				if (
					!closed &&
					completed &&
					pending === undefined &&
					terminal === undefined
				) {
					closed = true;
					controller.close();
				}
			};
			void run((value) => {
				if (!closed) {
					pending = value;
					flush();
				}
			}, abort.signal)
				.then(
					(value) => {
						terminal = { type: "result", value };
					},
					(error) => {
						terminal = { type: "error", error: errorValue(error) };
					},
				)
				.finally(() => {
					completed = true;
					pending = undefined;
					flush();
				});
		},
		pull() {
			flush();
		},
		cancel() {
			closed = true;
			pending = undefined;
			terminal = undefined;
			abort.abort();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson",
			"cache-control": "no-store",
		},
	});
}
