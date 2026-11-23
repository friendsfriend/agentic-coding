export type IdleClient = {
	/** Monotonic millisecond stamp for the last capability use. */
	lastActivity(): number;
	touch(now: number): void;
	isBusy(): boolean;
	ownedApps(): string[];
	stopApp(app: string, signal: AbortSignal): Promise<unknown>;
	/** Close an idle scope after owned cleanup; the next execution action may
	 * reopen a fresh scope. */
	close?(): Promise<void>;
};

/** Stops owned apps for a client whose capability activity is older than the TTL.
 * It never touches borrowed observations or closes the authenticated scope; an
 * active operation keeps the whole client exempt until it settles. */
export function createIdleReaper(
	clients: readonly IdleClient[],
	idleMs: number,
	options: { now?: () => number; signal: AbortSignal },
) {
	if (!Number.isSafeInteger(idleMs) || idleMs < 1)
		throw new Error("Invalid idle timeout");
	let running = false;
	return {
		async tick() {
			if (running || options.signal.aborted) return;
			running = true;
			try {
				const now = (options.now ?? Date.now)();
				for (const client of clients) {
					if (options.signal.aborted) return;
					try {
						if (now - client.lastActivity() < idleMs) continue;
						if (client.isBusy()) {
							client.touch(now);
							continue;
						}
						const apps = client.ownedApps();
						for (const app of apps) {
							if (options.signal.aborted) return;
							try {
								await client.stopApp(app, options.signal);
							} catch {
								// Retain the owned record and retry on a later tick.
							}
						}
						try {
							await client.close?.();
						} catch {
							// Keep the scope open when closure is uncertain.
						}
						client.touch(now);
					} catch {
						// An interrupted/closed scope or failed observation is not
						// converted into destructive action by the reaper.
						client.touch(now);
					}
				}
			} finally {
				running = false;
			}
		},
	};
}
