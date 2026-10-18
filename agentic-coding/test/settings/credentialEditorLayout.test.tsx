/** @jsxImportSource @opentui/solid */
// The credential editor's layout (`add-stage-testing-foundation`, task 5.1).
//
// The dialog is one text field in a box 60% of the terminal wide, which is where
// a row longer than its box stops being cosmetic: a row that does not fit wraps,
// and a wrapped row paints over the row below it — the masked draft over the
// counter, or the counter over the error. These tests are the saved frames that
// found that, kept as assertions: at 80 and at 74 columns every rendered line is
// the line it belongs to, the draft is masked, and a long one is cut with a
// marker instead of running into the next row.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	CredentialEditor,
	credentialContentColumns,
	fitLine,
	MAX_CREDENTIAL_CHARS,
} from "../../src/tui/settings/CredentialEditor.tsx";

const VARIABLE = "GRID_INT_CLERK_PASSWORD";
const LABEL = "password · clerk · Grid web · Grid integration";

/** The one line of a frame that holds `text`, or undefined. */
function lineWith(frame: string, text: string): string | undefined {
	return frame.split("\n").find((line) => line.includes(text));
}

/** Every line of a frame, trimmed, without the ones that are blank. */
function lines(frame: string): string[] {
	return frame
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

async function renderFrame(
	width: number,
	props: Partial<Parameters<typeof CredentialEditor>[0]> = {},
): Promise<string> {
	const t = await testRender(
		() => (
			<CredentialEditor
				label={LABEL}
				variable={VARIABLE}
				value="ab"
				{...props}
			/>
		),
		{ width, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	t.renderer.destroy();
	return frame;
}

test("the draft is masked, and the counter is a row of its own", async () => {
	const frame = await renderFrame(80);
	// The variable is the identity that survives a narrow title.
	expect(lineWith(frame, VARIABLE)).toBeDefined();
	// Masked: one bullet per character and a cursor, never the characters.
	expect(lineWith(frame, "••█")).toBeDefined();
	expect(frame).not.toContain("ab█");
	// The counter is its own line, and the draft row does not carry it.
	const counter = lines(frame).find((line) => line.includes("1024"));
	expect(counter).toBe(`2/${MAX_CREDENTIAL_CHARS} · Enter saves only this key`);
	// The rows are in order and do not interleave: draft, then counter.
	const rows = lines(frame);
	const draft = rows.findIndex((line) => line.includes("••█"));
	const counted = rows.findIndex((line) => line.includes("1024"));
	expect(draft).toBeGreaterThanOrEqual(0);
	expect(counted).toBe(draft + 1);
});

test("a narrow terminal cuts the intro line instead of wrapping it into the rows below", async () => {
	const frame = await renderFrame(74);
	const intro = lines(frame).find((line) => line.includes("Writes"));
	expect(intro).toBeDefined();
	// Fitted: the sentence is cut with a marker, which is what keeps it one row.
	expect(intro?.endsWith("…")).toBe(true);
	expect(intro?.length).toBeLessThanOrEqual(credentialContentColumns(74));
	// Nothing from the rows below bled into it.
	expect(intro).not.toContain("1024");
	expect(intro).not.toContain("••");
});

test("a long error and the saving hint keep one row each", async () => {
	const error =
		"credential-fill-failed: the value could not be typed into field #password and was not stored";
	const frame = await renderFrame(74, { error });
	const rows = lines(frame);
	const shown = rows.filter((line) => line.includes("credential-fill-failed"));
	expect(shown).toHaveLength(1);
	expect(shown[0]?.endsWith("…")).toBe(true);
	// The counter above it is untouched by the cut error.
	expect(rows.find((line) => line.includes("1024"))).toContain("2/1024");
	// The error replaced the saving hint rather than joining it.
	expect(frame).not.toContain("saving…");

	const saving = await renderFrame(74, { saving: true });
	const hint = lines(saving).filter((line) => line.includes("saving…"));
	expect(hint).toHaveLength(1);
	expect(hint[0]?.endsWith("…")).toBe(true);
});

test("the fitting helpers keep a row inside its box", () => {
	expect(fitLine("short", 10)).toBe("short");
	// Exactly at the limit is not cut: there is nothing to hide.
	expect(fitLine("exactly-10", 10)).toBe("exactly-10");
	// One over the limit is cut, with a marker in the last column.
	expect(fitLine("eleven-char", 10)).toBe("eleven-ch…");
	expect(fitLine("eleven-char", 10)).toHaveLength(10);
	// A width no row can use is still a width: never a negative slice.
	expect(fitLine("abc", 0)).toBe("…");
	expect(fitLine("", 4)).toBe("");
	// A surrogate pair is one character, so a cut cannot split one in half.
	expect(fitLine("🧪🧪🧪🧪", 3)).toBe("🧪🧪…");
	// The content box: 60% of the terminal, two columns of padding each side, less
	// the column a fitted line's marker must not use.
	expect(credentialContentColumns(80)).toBe(43);
	expect(credentialContentColumns(74)).toBe(39);
	expect(credentialContentColumns(20)).toBe(8);
});
