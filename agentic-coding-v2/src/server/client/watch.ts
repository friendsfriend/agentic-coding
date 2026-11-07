import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import type { Transcript } from "../../protocol/index.ts";
import type { Runtime } from "../../runtime.ts";
import { clientSession, readSession } from "./handlers/sessions.ts";

export type SessionWatch = { stop(): Promise<void> };
/** Native commits invalidate a latest-state projection, not a replayable event log.
 * One read in flight; bursts coalesce for 100 ms. No model/engine operation is started.
 */
export async function watchSession(
	app: Runtime,
	id: number,
	onValue: (value: Transcript) => void,
	onUnavailable: () => void,
): Promise<SessionWatch> {
	const session = await clientSession(app, id, false);
	const stream = await watchEvents(app.harness, session.id, context);
	let closed = false,
		dirty = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active: Promise<void> | null = null;
	function retire() {
		closed = true;
		if (timer) clearTimeout(timer);
		timer = null;
		return stream.stop();
	}
	function schedule() {
		dirty = true;
		if (closed || timer || active) return;
		timer = setTimeout(() => {
			timer = null;
			void launch();
		}, 100);
	}
	async function refresh() {
		try {
			const value = await readSession(app, id);
			if (!closed) onValue(value);
		} catch {
			if (!closed) {
				onUnavailable();
				await retire();
			}
		}
	}
	function launch() {
		if (active) return active;
		dirty = false;
		active = refresh().finally(() => {
			active = null;
			if (dirty) schedule();
		});
		return active;
	}
	void stream.closed.then(() => {
		if (!closed) {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			onUnavailable();
		}
	});
	try {
		// Registration already exists, so commits during the initial projection
		// cannot be lost. Native overflow snapshots also invalidate the projection.
		await stream.start(async () => schedule());
		await launch();
	} catch (error) {
		await retire();
		throw error;
	}
	return {
		async stop() {
			await retire();
			await active;
		},
	};
}
