/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { batch, createSignal } from "solid-js";
import {
	Form,
	type FormErrors,
	type FormField,
	type FormValues,
} from "./Form.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("form fields and choices retain native text while descriptors, values, errors and order change", async () => {
	const [fields, setFields] = createSignal<FormField[]>([
		{ key: "mode", label: "Mode", kind: "select", options: ["alpha", "beta"] },
		{ key: "name", label: "Name", kind: "text" },
	]);
	const [values, setValues] = createSignal<FormValues>({
		mode: "alpha",
		name: "",
	});
	const [errors, setErrors] = createSignal<FormErrors>({});
	const [active, setActive] = createSignal(0);
	const [cursor, setCursor] = createSignal(0);
	const t = await testRender(
		() => (
			<Form
				fields={fields()}
				values={values()}
				errors={errors()}
				activeIndex={active()}
				choiceCursorIndex={cursor()}
				focusedPane="value"
				availableLines={12}
			/>
		),
		{ width: 120, height: 20 },
	);
	try {
		await t.flush();
		const field = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "Mode",
		);
		const beta = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "○ beta",
		);
		if (!(field instanceof TextRenderable) || !(beta instanceof TextRenderable))
			throw new Error("Missing form fields");
		batch(() => {
			setFields((current) =>
				current.map((item) => ({
					...item,
					...(item.key === "mode"
						? { label: "Updated mode", options: ["alpha", "beta"] }
						: {}),
				})),
			);
			setValues({ mode: "beta", name: "" });
			setErrors({ mode: "Check this choice" });
			setCursor(1);
		});
		await t.renderOnce();
		expect(field.isDestroyed).toBe(false);
		expect(beta.isDestroyed).toBe(false);
		expect(field.plainText).toBe("⚠ Updated mode");
		expect(beta.plainText).toBe("● beta");
		expect(t.captureCharFrame()).toContain("Check this choice");
		batch(() => {
			setFields((current) => [...current].reverse());
			setActive(1);
		});
		await t.renderOnce();
		expect(field.isDestroyed).toBe(false);
		expect(beta.isDestroyed).toBe(false);
		batch(() => {
			setFields((current) =>
				current.map((item) =>
					item.key === "mode" ? { ...item, key: "another-mode" } : item,
				),
			);
			setValues({ "another-mode": "beta", name: "" });
		});
		await t.renderOnce();
		expect(field.isDestroyed).toBe(true);
		expect(beta.isDestroyed).toBe(true);
		expect(t.captureCharFrame()).toContain("● beta");
	} finally {
		t.renderer.destroy();
	}
});
