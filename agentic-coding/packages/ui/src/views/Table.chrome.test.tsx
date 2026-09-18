/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import type { TableRow } from "@devenv/types";
import { testRender } from "@opentui/solid";
import { publishHostChrome } from "../components/hostChrome";
import { Table, type TableColumn } from "./Table";

// Embedded versus standalone layout (compose-unified-feature-shell chrome
// budget): the feature must not reserve the header/footer rows the shell
// renders, or every embedded list silently loses rows.
const columns: TableColumn[] = [{ key: "name", header: "Name", width: 20 }];
const rows: TableRow[] = Array.from({ length: 40 }, (_, index) => ({
	ident: `app-${index}`,
	displayName: `app-${index}`,
	rowKind: "app",
	appType: "APP",
})) as TableRow[];

async function renderedRowCount(): Promise<number> {
	const t = await testRender(
		() => (
			<Table
				apps={rows}
				columns={columns}
				selectedIndex={0}
				showBorder={false}
				tabs={[{ id: "applications", label: "Applications" }]}
				activeTab="applications"
			/>
		),
		{ width: 80, height: 20 },
	);
	// Settle the frame before measuring: one pass is not always enough for the
	// virtual list to lay out its rows.
	await t.renderOnce();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	t.renderer.destroy();
	return frame.split("\n").filter((line) => line.includes("app-")).length;
}

describe("embedded table height", () => {
	test("the shell's chrome rows replace the feature's own header and footer", async () => {
		publishHostChrome(undefined);
		const standalone = await renderedRowCount();
		// Standalone reserves LAYOUT_CHROME_LINES (5: its own 2-line header and
		// 3-line footer).
		publishHostChrome({ lines: 2, namesPage: true });
		const embedded = await renderedRowCount();
		publishHostChrome(undefined);

		expect(standalone).toBeGreaterThan(0);
		// Fixed geometry: the three rows the feature no longer reserves (5 - 2)
		// reach the two-line rows as two more visible rows. The point of the
		// assertion is that the embedded list is taller, not shorter.
		expect(embedded).toBe(standalone + 2);
	});
});
