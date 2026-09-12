import { describe, expect, test } from "bun:test";
import { calculateVisibleItems } from "./virtualScroll";

describe("calculateVisibleItems", () => {
	test("keeps uniform-height window stable while selection stays within page", () => {
		const items = Array.from({ length: 50 }, (_, i) => i);

		const at0 = calculateVisibleItems(items, {
			totalItems: items.length,
			selectedIndex: 0,
			visibleHeight: 10,
			estimatedItemHeight: 1,
		});
		const at9 = calculateVisibleItems(items, {
			totalItems: items.length,
			selectedIndex: 9,
			visibleHeight: 10,
			estimatedItemHeight: 1,
		});
		const at10 = calculateVisibleItems(items, {
			totalItems: items.length,
			selectedIndex: 10,
			visibleHeight: 10,
			estimatedItemHeight: 1,
		});

		expect(at0.startIndex).toBe(0);
		expect(at9.startIndex).toBe(0);
		expect(at10.startIndex).toBe(10);
	});
});
