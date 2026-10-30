/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScheduleDetails } from "../src/tui/schedules/ScheduleDetails.tsx";

for (const width of [38, 100]) {
	test(`schedule details preserve nested and unfamiliar fields at width ${width}`, async () => {
		const t = await testRender(
			() => (
				<ScheduleDetails
					width={width}
					content={JSON.stringify({
						name: "Daily review",
						state: "paused",
						timing: { kind: "cron", timezone: "Europe/Berlin" },
						extraFutureField: { evidence: "retained evidence" },
						history: [{ status: "failed", reason: "full failure reason" }],
						empty: [],
						nullable: null,
					})}
				/>
			),
			{ width, height: 45 },
		);
		try {
			await t.renderOnce();
			const frame = t.captureCharFrame();
			for (const value of [
				"Daily review",
				"paused",
				"Europe/Berlin",
				"Extra Future Field",
				"retained evidence",
				"full failure reason",
				"None",
			])
				expect(frame).toContain(value);
			expect(frame).not.toContain('"timezone"');
		} finally {
			t.renderer.destroy();
		}
	});
}
