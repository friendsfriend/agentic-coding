// What the tab shell itself owns: the four telemetry stores can be constructed
// together and stay empty and independent until they are loaded. Each store's
// own behaviour (and its fresh-empty case) is asserted in its owning suite —
// logStore.test.ts, metricStore.test.ts, topologyStore.test.ts — so this file
// keeps only the guarantees that belong to mounting all four at once.
import { describe, expect, it } from "bun:test";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";

describe("Tab shell", () => {
	it("TraceStore starts empty", () => {
		const store = new TraceStore();
		expect(store.spanCount_).toBe(0);
		expect(store.filteredCount_).toBe(0);
	});

	it("TopologyStore starts empty", () => {
		const store = new TopologyStore();
		expect(store.getServices()).toEqual([]);
	});

	it("stores are independent (no cross-contamination)", () => {
		const traceStore = new TraceStore();
		const metricStore = new MetricStore([
			{
				resource: { attributes: [] },
				scope: { name: "", version: "" },
				name: "cpu",
				description: "",
				unit: "",
				type: "gauge",
				dataPoints: [],
				serviceName: "web",
			},
		]);

		expect(traceStore.spanCount_).toBe(0);
		expect(metricStore.metricCount_).toBe(1);
	});
});
