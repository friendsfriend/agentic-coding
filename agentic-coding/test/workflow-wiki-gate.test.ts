import { expect, test } from "bun:test";
import { requiredUserActionFor } from "../src/tui/dash/data.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";

test("archive-bearing workflows document, review, then archive", () => {
	const registry = registerBuiltins();
	for (const id of ["standard", "direct-apply", "plan-fusion"]) {
		const definition = registry.definition(id, definitionVersionForPolicy(6));
		const wiki = definition.steps.indexOf("core.wiki");
		expect(definition.steps.slice(wiki, wiki + 4)).toEqual([
			"core.wiki",
			"core.wiki-approval",
			"core.archive",
			"core.delivery",
		]);
		expect(
			definition.edges.find(
				(edge) => edge.from === "core.wiki" && edge.outcome === "complete",
			)?.to,
		).toBe("core.wiki-approval");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "approve",
			)?.to,
		).toBe("core.archive");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "approve",
			)?.effects?.[0]?.kind,
		).toBe("wiki.verify");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "comments",
			)?.to,
		).toBe("core.wiki");
	}
	const noOpenSpec = registry.definition("no-openspec", 1);
	expect(noOpenSpec.steps).not.toContain("core.wiki");
	expect(noOpenSpec.steps).not.toContain("core.wiki-approval");
});

test("wiki approval has a trigger-only user action", () => {
	expect(requiredUserActionFor("core.wiki-approval")).toEqual({
		key: "wiki-review",
		title: "Action required · Wiki review",
		prompt: "Review knowledge changes before archival.",
		items: [],
	});
});
