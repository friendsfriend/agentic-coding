import { createSocket } from "node:dgram";
import { Refusal } from "../../server/refusal.ts";
import type {
	MetricCollectorKind,
	MetricCollectorState,
	MetricData,
} from "../contracts.ts";
import { parsePrometheusText } from "./prometheus.ts";
import { normalizeStatsDMetrics } from "./statsd.ts";

type Owned = { stop: () => Promise<void> };
/** Explicit operator-owned sources. No discovery, redirects, remote hosts,
 * automatic restarts or native application/lease authority. */
export class MetricCollectors {
	private closed = false;
	private readonly owned = new Map<MetricCollectorKind, Owned>();
	private readonly pending = new Map<MetricCollectorKind, Promise<void>>();
	private readonly states: Record<MetricCollectorKind, MetricCollectorState> = {
		statsd: { revision: 0, status: "stopped", address: null, lastError: null },
		prometheus: {
			revision: 0,
			status: "stopped",
			address: null,
			lastError: null,
		},
	};
	constructor(private readonly ingest: (metrics: MetricData[]) => void) {}
	read() {
		return {
			statsd: { ...this.states.statsd },
			prometheus: { ...this.states.prometheus },
		};
	}
	async control(
		kind: MetricCollectorKind,
		operation: "start" | "stop",
		revision: number,
		port = 0,
	) {
		if (this.closed || this.pending.has(kind))
			throw new Refusal("Collector transition unavailable; refresh its state");
		const state = this.states[kind];
		if (state.revision !== revision)
			throw new Refusal("Collector revision changed; refresh its state");
		if (operation === "start" ? this.owned.has(kind) : !this.owned.has(kind))
			throw new Refusal(
				`Collector is already ${operation === "start" ? "running" : "stopped"}`,
			);
		if (
			!Number.isSafeInteger(port) ||
			port < (kind === "prometheus" && operation === "start" ? 1 : 0) ||
			port > 65535
		)
			throw new Refusal("Invalid collector port");
		state.revision++;
		state.status = operation === "start" ? "starting" : "stopping";
		state.lastError = null;
		const work = (async () => {
			if (operation === "stop") {
				await this.owned.get(kind)?.stop();
				this.owned.delete(kind);
				state.status = "stopped";
				state.address = null;
				return;
			}
			try {
				const owned =
					kind === "statsd"
						? await this.startStatsD(port)
						: this.startPrometheus(port);
				this.owned.set(kind, owned);
				state.status = "running";
			} catch {
				state.status = "stopped";
				state.address = null;
				throw new Refusal(
					"Collector could not start; check the port and refresh",
				);
			}
		})();
		this.pending.set(kind, work);
		try {
			await work;
			return this.read();
		} finally {
			this.pending.delete(kind);
		}
	}
	private async startStatsD(port: number): Promise<Owned> {
		const socket = createSocket("udp4");
		const state = this.states.statsd;
		// StatsD has no wire timestamps. Anchor a monotonic observation clock
		// to wall time, owned by this listener, without millisecond collisions.
		const epoch = BigInt(Date.now()) * 1_000_000n,
			origin = process.hrtime.bigint();
		let last = epoch;
		const observedAt = () => {
			const now = epoch + process.hrtime.bigint() - origin;
			last = now > last ? now : last + 1n;
			return last.toString();
		};
		let stopped = false,
			windowStart = 0,
			received = 0;
		socket.on("message", (data, remote) => {
			if (
				stopped ||
				this.closed ||
				remote.address !== "127.0.0.1" ||
				data.length > 8192
			)
				return;
			const now = Date.now();
			if (now - windowStart >= 1000) {
				windowStart = now;
				received = 0;
			}
			if (++received > 100) return;
			try {
				const lines = data.toString("utf8").split(/\r?\n/);
				if (lines.length > 128) return;
				const metrics = normalizeStatsDMetrics(
					lines,
					"statsd-loopback",
					observedAt,
				);
				if (!metrics.length) return;
				this.ingest(metrics);
				state.lastError = null;
			} catch {
				state.lastError = "Invalid StatsD datagram refused";
			}
		});
		await new Promise<void>((resolve, reject) => {
			const failed = () => {
				try {
					socket.close();
				} catch {}
				reject(new Error("UDP bind failed"));
			};
			socket.once("error", failed);
			socket.bind(port, "127.0.0.1", () => {
				socket.removeListener("error", failed);
				resolve();
			});
		});
		socket.on("error", () => {
			state.lastError = "StatsD socket error; stop and restart explicitly";
		});
		state.address = `udp://127.0.0.1:${socket.address().port}`;
		return {
			stop: async () => {
				if (stopped) return;
				stopped = true;
				await new Promise<void>((resolve) => socket.close(() => resolve()));
			},
		};
	}
	private startPrometheus(port: number): Owned {
		const state = this.states.prometheus;
		const controller = new AbortController();
		state.address = `http://127.0.0.1:${port}/metrics`;
		const url = state.address;
		let running: Promise<void> | undefined;
		const scrape = async () => {
			try {
				const response = await fetch(url, {
					// A process-level proxy must not turn a local source into an
					// outbound request or supply proxy credentials implicitly.
					proxy: false,
					redirect: "error",
					signal: AbortSignal.any([
						controller.signal,
						AbortSignal.timeout(2000),
					]),
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error("Scrape refused");
				}
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const result = await reader.read();
						if (result.done) break;
						size += result.value.byteLength;
						if (size > 262144) throw new Error("Scrape too large");
						chunks.push(result.value);
					}
				} finally {
					await reader.cancel();
				}
				const metrics = parsePrometheusText(
					Buffer.concat(chunks).toString("utf8"),
					`prometheus-loopback:${port}`,
				);
				if (!controller.signal.aborted && !this.closed) {
					if (metrics.length) this.ingest(metrics);
					state.lastError = null;
				}
			} catch {
				if (!controller.signal.aborted && !this.closed)
					state.lastError = "Prometheus scrape failed or payload refused";
			}
		};
		const tick = () => {
			if (running || controller.signal.aborted) return;
			running = scrape().finally(() => {
				running = undefined;
			});
		};
		const timer = setInterval(tick, 10000);
		tick();
		return {
			stop: async () => {
				clearInterval(timer);
				controller.abort();
				await running;
			},
		};
	}
	async close() {
		this.closed = true;
		await Promise.allSettled([...this.pending.values()]);
		await Promise.all([...this.owned.values()].map((item) => item.stop()));
		this.owned.clear();
		for (const state of Object.values(this.states)) {
			state.status = "stopped";
			state.address = null;
		}
	}
}
