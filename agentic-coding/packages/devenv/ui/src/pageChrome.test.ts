import { describe, expect, test } from "bun:test";
import {
	hostChromeLines,
	hostNamesPage,
	publishHostChrome,
} from "./pageChrome";

// The chrome gate (tabs) and line budget (table height) are one contract: the
// host publishes its chrome once and every consumer reads it. Standalone is
// `undefined`, which keeps the feature's own header/footer and its identity
// rows.
describe("host page chrome", () => {
	test("standalone renders every identity row and reserves its own chrome", () => {
		expect(hostNamesPage()).toBe(false);
		expect(hostChromeLines(5)).toBe(5);
	});

	test("embedded suppresses identity rows and reserves the host chrome", () => {
		publishHostChrome({ lines: 2, namesPage: true });
		expect(hostNamesPage()).toBe(true);
		// The shell's logo bar + breadcrumb, not the feature's header/footer.
		expect(hostChromeLines(5)).toBe(2);
	});

	test("a chrome-less host keeps identity rows but reserves nothing", () => {
		publishHostChrome({ lines: 0, namesPage: false });
		expect(hostNamesPage()).toBe(false);
		expect(hostChromeLines(5)).toBe(0);
	});

	test("clearing the publication restores standalone behavior", () => {
		publishHostChrome({ lines: 2, namesPage: true });
		publishHostChrome(undefined);
		expect(hostNamesPage()).toBe(false);
		expect(hostChromeLines(5)).toBe(5);
	});
});
