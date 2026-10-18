// The main-thread diagnostics monitor (fix-tui-freezes-and-memory).
//
// Everything observable is injected, so a freeze is simulated exactly: the test
// owns the clock, the timers, the memory reader and the sink. What must hold:
// a lag is recorded once with the sections that ran in its window, a normal
// tick records nothing, memory is sampled at a low rate, and no record may
// carry anything but numbers and code-chosen section names.
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	formatDiagnosticsReport,
	readDiagnosticsReport,
} from "../../src/server/diagnostics/command.ts";
import {
	DIAGNOSTICS_LOG_MAX_BYTES,
	openDiagnosticsLog,
} from "../../src/server/diagnostics/log.ts";
import {
	createDiagnosticsMonitor,
	DIAGNOSTICS_LAG_TICK_MS,
	DIAGNOSTICS_REPORTED_SECTIONS,
	type DiagnosticsCacheCount,
	type DiagnosticsSectionTiming,
} from "../../src/server/diagnostics/monitor.ts";

/** A clock and a timer queue the test drives by hand. */
class FakeClock {
	now = 0;
	#queue: Array<{ at: number; run: () => void; cancelled: boolean }> = [];

	readonly nowFn = (): number => this.now;
	readonly schedule = (run: () => void, ms: number): unknown => {
		const entry = { at: this.now + ms, run, cancelled: false };
		this.#queue.push(entry);
		return entry;
	};
	readonly cancel = (handle: unknown): void => {
		const entry = handle as { cancelled: boolean } | undefined;
		if (entry) entry.cancelled = true;
	};

	/** Advance the clock with the loop free: every timer that comes due runs, in
	 * order, and one that is already late runs as late as it now is. */
	advance(ms: number): void {
		this.now += ms;
		this.runDue();
	}

	/** A synchronous block: time passes while no timer can run, which is exactly
	 * what a lag spike is. The next `advance` runs the ticker that missed it. */
	block(ms: number): void {
		this.now += ms;
	}

	private runDue(): void {
		for (;;) {
			const due = this.#queue
				.filter((entry) => !entry.cancelled && entry.at <= this.now)
				.sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.#queue = this.#queue.filter((entry) => entry !== due);
			if (due.at > this.now) this.now = due.at;
			due.run();
		}
	}
}

function harness(
	options: {
		readonly rss?: number;
		readonly caches?: () => readonly DiagnosticsCacheCount[];
	} = {},
) {
	const clock = new FakeClock();
	const records: Array<Record<string, unknown>> = [];
	const monitor = createDiagnosticsMonitor({
		write: (line) => {
			records.push(JSON.parse(line) as Record<string, unknown>);
		},
		now: clock.nowFn,
		memory: () => ({
			rss: options.rss ?? 800 * 1_048_576,
			heapUsed: 300 * 1_048_576,
			heapTotal: 400 * 1_048_576,
		}),
		uptimeSeconds: () => 120,
		...(options.caches ? { caches: options.caches } : {}),
		schedule: clock.schedule,
		cancel: clock.cancel,
	});
	return { clock, records, monitor };
}

describe("diagnostics monitor", () => {
	it("records nothing while the loop keeps up", () => {
		const { clock, records } = harness();
		for (let tick = 0; tick < 20; tick++)
			clock.advance(DIAGNOSTICS_LAG_TICK_MS);
		expect(records).toHaveLength(0);
		expect(clock.now).toBeGreaterThan(0);
	});

	it("records one lag spike with the sections that ran in its window", () => {
		const { clock, records, monitor } = harness();
		// Two sections, the slow one reported first.
		monitor.measure("store.listViews", () => {
			// The loop is blocked: the ticker due 200ms in cannot run.
			clock.block(320);
		});
		monitor.record("render.refresh", 12);
		monitor.record("tiny", 0.1);
		// The loop is free again, so the ticker runs ~320ms late.
		clock.advance(1);
		const lag = records.filter((record) => record.kind === "lag");
		expect(lag).toHaveLength(1);
		// The section that blocked the loop is reported by name and duration.
		expect(Number(lag[0]?.lagMs)).toBeGreaterThan(0);
		const sections = (lag[0]?.sections ?? []) as DiagnosticsSectionTiming[];
		expect(sections.map((section) => section.name)).toEqual([
			"store.listViews",
			"render.refresh",
		]);
		expect(Number(lag[0]?.rssMb)).toBe(800);
	});

	it("reports the slowest sections, bounded, per spike", () => {
		const { clock, records, monitor } = harness();
		for (let index = 0; index < DIAGNOSTICS_REPORTED_SECTIONS + 4; index++)
			monitor.record(`section-${index}`, 100 + index);
		clock.advance(DIAGNOSTICS_LAG_TICK_MS + 500);
		const lag = records.find((record) => record.kind === "lag");
		const sections = (lag?.sections ?? []) as DiagnosticsSectionTiming[];
		expect(sections).toHaveLength(DIAGNOSTICS_REPORTED_SECTIONS);
		expect(sections[0]?.name).toBe(
			`section-${DIAGNOSTICS_REPORTED_SECTIONS + 3}`,
		);
	});

	it("forgets a window's sections once the tick reported them", () => {
		const { clock, records, monitor } = harness();
		monitor.record("store.listViews", 400);
		clock.advance(DIAGNOSTICS_LAG_TICK_MS + 300);
		const first = records.find((record) => record.kind === "lag");
		expect((first?.sections ?? []) as DiagnosticsSectionTiming[]).toHaveLength(
			1,
		);
		// A later tick that is on time reports nothing, so the old section is gone.
		clock.advance(DIAGNOSTICS_LAG_TICK_MS);
		expect(records.filter((record) => record.kind === "lag")).toHaveLength(1);
	});

	it("samples memory, with cache counts, once a minute", () => {
		const caches = (): readonly DiagnosticsCacheCount[] => [
			{ name: "telemetry.spans", entries: 20_000 },
		];
		const { clock, records } = harness({ caches });
		clock.advance(60_000 + DIAGNOSTICS_LAG_TICK_MS * 2);
		const memory = records.filter((record) => record.kind === "memory");
		expect(memory).toHaveLength(1);
		expect(Number(memory[0]?.heapUsedMb)).toBe(300);
		expect(memory[0]?.caches).toEqual([
			{ name: "telemetry.spans", entries: 20_000 },
		]);
	});

	it("keeps a bounded ring of recent spikes for the surface", () => {
		const { clock, records, monitor } = harness();
		for (let index = 0; index < 40; index++) {
			monitor.record("store.listViews", 500);
			clock.advance(DIAGNOSTICS_LAG_TICK_MS + 200);
		}
		expect(records.filter((record) => record.kind === "lag").length).toBe(40);
		expect(monitor.spikes().length).toBeLessThanOrEqual(16);
		expect(monitor.stats().spikes.length).toBeLessThanOrEqual(16);
		expect(monitor.stats().caches).toEqual([]);
	});

	it("writes a report on demand without a heap snapshot", () => {
		const { records, monitor } = harness();
		monitor.report("signal");
		const report = records.find((record) => record.kind === "report");
		expect(report?.note).toBe("signal");
		expect(Number(report?.rssMb)).toBe(800);
		// One report and its memory line; nothing else.
		expect(records.length).toBe(2);
	});

	it("never writes anything but numbers and code-chosen names", () => {
		const { clock, records, monitor } = harness();
		monitor.record("a name with spaces /etc/passwd", 500);
		monitor.record("store.listViews", 250);
		clock.advance(DIAGNOSTICS_LAG_TICK_MS + 400);
		const line = JSON.stringify(records);
		expect(line).not.toContain("/etc/passwd");
		expect(line).not.toContain("a name with spaces");
		expect(line).toContain("unnamed");
		expect(line).toContain("store.listViews");
	});

	it("stops its ticker when stopped", () => {
		const { clock, records, monitor } = harness();
		monitor.stop();
		clock.advance(DIAGNOSTICS_LAG_TICK_MS * 10 + 1_000);
		expect(records).toHaveLength(0);
	});
});

describe("diagnostics log", () => {
	it("rotates once past the size cap and keeps the newest lines", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-log-"));
		try {
			const log = openDiagnosticsLog({
				path: path.join(dir, "tui.log"),
				maxBytes: 120,
			});
			for (let index = 0; index < 20; index++)
				log.write(`{"kind":"memory","n":${index}}`);
			expect(log.size()).toBeLessThanOrEqual(120);
			expect(fs.existsSync(`${log.path}.1`)).toBe(true);
			const tail = log.tail(3);
			expect(tail.at(-1)).toContain('"n":19');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("has a bounded default size", () => {
		expect(DIAGNOSTICS_LOG_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
	});
});

describe("diagnostics report formatting", () => {
	it("summarizes the newest records", () => {
		const report = {
			logPath: "/tmp/tui.log",
			logBytes: 2048,
			rotatedBytes: 0,
			lagCount: 2,
			worstLagMs: 640,
			lastSpikeAt: "2026-10-18T09:00:00.000Z",
			recent: [
				{
					kind: "lag",
					at: "2026-10-18T09:00:00.000Z",
					lagMs: 640,
					rssMb: 812,
					heapUsedMb: 300,
					sections: [{ name: "store.listViews", ms: 610 }],
				},
			],
		};
		const lines = formatDiagnosticsReport(report);
		expect(lines[0]).toContain("/tmp/tui.log");
		expect(lines[1]).toContain("2.0 KiB");
		expect(lines[2]).toContain("worst 640ms");
		expect(lines[3]).toContain("store.listViews 610ms");
	});
});

describe("diagnostics log reading", () => {
	it("reads an absent log as an empty report", () => {
		const report = readDiagnosticsReport();
		expect(report.lagCount).toBe(0);
		expect(report.worstLagMs).toBe(0);
		expect(report.recent).toEqual([]);
	});
});
