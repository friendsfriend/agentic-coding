/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	Form,
	type FormField,
	firstErrorField,
	formDefaults,
	formDisplay,
	formOptionIndex,
	formStepOption,
	formValues,
	uiColors,
} from "@ui";

const fields: FormField[] = [
	{ key: "name", label: "Name", kind: "text" },
	{
		key: "runtime",
		label: "Runtime",
		kind: "select",
		options: ["pi", "opencode"],
		defaultValue: "pi",
	},
	{ key: "note", label: "Note", kind: "text", defaultValue: "—" },
];

test("a blank form applies each field default", () => {
	expect(formDefaults(fields)).toEqual({
		name: "",
		runtime: "pi",
		note: "—",
	});
});

test("stored values override defaults but missing keys keep them", () => {
	expect(formValues(fields, { name: "fast" })).toEqual({
		name: "fast",
		runtime: "pi",
		note: "—",
	});
});

test("select options resolve and step with a wrap", () => {
	const runtime = fields[1] as FormField;
	expect(formOptionIndex(runtime, "opencode")).toBe(1);
	expect(formOptionIndex(runtime, "missing")).toBe(0);
	expect(formStepOption(runtime, "pi", 1)).toBe("opencode");
	expect(formStepOption(runtime, "opencode", 1)).toBe("pi");
	expect(formStepOption(runtime, "pi", -1)).toBe("opencode");
});

test("display falls back to the placeholder", () => {
	expect(formDisplay(fields[0] as FormField, "")).toBe("—");
	expect(formDisplay(fields[0] as FormField, "value")).toBe("value");
});

test("the first errored field is the focused one", () => {
	expect(firstErrorField(fields, {})).toBe(0);
	expect(firstErrorField(fields, { runtime: "bad" })).toBe(1);
});

/** RGB channels of a `#rrggbb` theme colour. */
function rgb(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16),
	];
}

test("the form renders labels, values and a styled validation error", async () => {
	const t = await testRender(
		() => (
			<Form
				fields={fields}
				values={{ name: "", runtime: "pi", note: "" }}
				errors={{ name: "Name is required" }}
				activeIndex={0}
				editing
				availableLines={10}
			/>
		),
		{ width: 80, height: 12 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Name");
	expect(frame).toContain("Runtime");
	expect(frame).toContain("pi");
	expect(frame).toContain("Name is required");

	// The error is not just text: it renders in the theme error colour on the
	// line directly under the field that produced it.
	const lines = t.captureSpans().lines;
	const errorLine = lines.findIndex((line) =>
		line.spans.some((span) => span.text.includes("Name is required")),
	);
	const fieldLine = lines.findIndex((line) =>
		line.spans.some(
			(span) => span.text.includes("Name") && !span.text.includes("required"),
		),
	);
	expect(errorLine).toBe(fieldLine + 1);
	const errorSpan = lines[errorLine]?.spans.find((span) =>
		span.text.includes("Name is required"),
	);
	const [red, green, blue] = rgb(uiColors.error);
	expect(errorSpan?.fg.buffer[0]).toBe(red);
	expect(errorSpan?.fg.buffer[1]).toBe(green);
	expect(errorSpan?.fg.buffer[2]).toBe(blue);
	t.renderer.destroy();
});
