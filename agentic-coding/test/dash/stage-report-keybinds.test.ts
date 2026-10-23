import { describe, expect, test } from "bun:test";
import { catalogKeybinds, footerKeybinds } from "@ui";
import {
	stagePlanReviewKeybindCatalog,
	stagePlanReviewKeybindsForView,
	stageReportReviewKeybindCatalog,
	stageReportReviewKeybinds,
} from "../../src/tui/dash/keybinds.ts";

describe("stage report review keybinds", () => {
	test("makes wiki approval the default with explicit skip and hides standard navigation in the footer", () => {
		const withWiki = stageReportReviewKeybindCatalog(true);
		const withoutWiki = stageReportReviewKeybindCatalog(false);
		const all = catalogKeybinds(withWiki).map((keybind) => keybind.key);
		const footer = footerKeybinds(withWiki).map((keybind) => keybind.key);

		expect(all).toContain("Shift+F");
		expect(
			catalogKeybinds(withoutWiki).map((keybind) => keybind.key),
		).not.toContain("Shift+F");
		expect(footer).toContain("f");
		expect(stageReportReviewKeybinds(true)).toContainEqual({
			key: "f",
			action: "Approve and update wiki",
		});
		expect(stageReportReviewKeybinds(false)).toContainEqual({
			key: "f",
			action: "Approve report",
		});
		expect(footer).toContain("c");
		expect(footer).not.toContain("j/k");
		expect(
			stageReportReviewKeybinds(true).map((keybind) => keybind.action),
		).toContain("Approve and update wiki");
	});
});

describe("stage plan review keybinds", () => {
	test("advertises plan rejection only while the engine offers it", () => {
		const withReject = catalogKeybinds(
			stagePlanReviewKeybindCatalog(true, "diff"),
		).map(({ key }) => key);
		const withoutReject = catalogKeybinds(
			stagePlanReviewKeybindCatalog(false, "diff"),
		).map(({ key }) => key);
		expect(withReject).toContain("r");
		expect(withoutReject).not.toContain("r");
	});

	test("a single plan document names no file navigation and Esc closes", () => {
		const footer = footerKeybinds(
			stagePlanReviewKeybindCatalog(true, "diff"),
		).map(({ key, action }) => ({ key, action }));
		expect(footer.map(({ key }) => key)).not.toContain("n/N");
		expect(footer).toContainEqual({
			key: "Esc",
			action: "Close plan review",
		});
		expect(
			stagePlanReviewKeybindsForView(true, "files").map(({ key }) => key),
		).toContain("Enter");
	});
});
