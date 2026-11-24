import { expect, test } from "bun:test";
import { createEnvironmentEventBus } from "../src/services/event-bus.ts";

test("event bus filters by repository, replays and detaches", () => {
	const bus = createEnvironmentEventBus(3, 1);
	const seen: string[] = [];
	const unsubscribe = bus.subscribe(["/repo/a"], (event) =>
		seen.push(event.type),
	);
	if (!unsubscribe) throw new Error("expected subscriber");
	bus.publish({ type: "status", repository: "/repo/b" });
	bus.publish({ type: "status", repository: "/repo/a" });
	bus.publish({ type: "git", repository: "/repo/a" });
	bus.publish({ type: "operation", repository: "/repo/a", operationId: "op" });
	expect(seen).toEqual(["status", "git", "operation"]);
	expect(bus.replayAfter(1, ["/repo/a"]).map((event) => event.seq)).toEqual([
		2, 3, 4,
	]);
	expect(bus.replayAfter(1, ["/repo/b"])).toEqual([]);
	expect(bus.subscribe(["/repo/a"], () => {})).toBeUndefined();
	unsubscribe();
	bus.publish({ type: "status", repository: "/repo/a" });
	expect(seen).toHaveLength(3);
});
