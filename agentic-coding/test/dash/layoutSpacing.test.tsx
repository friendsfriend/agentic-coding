/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Layout } from "../../src/tui/dash/ui/Layout";

const WIDTH = 40;
const HEIGHT = 10;

function DashboardFixture(props: { label: "Home" | "Detail" }) {
	return (
		<Layout
			header={<text>{props.label} header</text>}
			content={<text>{props.label} panel</text>}
			footer={<text>{props.label} footer</text>}
		/>
	);
}

for (const label of ["Home", "Detail"] as const) {
	test(`${label.toLowerCase()} dashboard keeps header and footer at terminal edges`, async () => {
		const t = await testRender(() => <DashboardFixture label={label} />, {
			width: WIDTH,
			height: HEIGHT,
		});
		await t.flush();
		const rows = t.captureCharFrame().split("\n");
		expect(rows[0]).toContain(`${label} header`);
		expect(rows[HEIGHT - 1]).toContain(`${label} footer`);
		expect(rows.join("\n")).toContain(`${label} panel`);
		t.renderer.destroy();
	});
}
