import { describe, expect, test } from "bun:test";
import { providerMarkdown } from "../src/environments/markdown.ts";

describe("provider markdown normalization", () => {
	test("converts common GitLab system-note HTML", () => {
		const value = providerMarkdown(
			'<p>Added <strong>2</strong> commits</p><ul><li><code>develop</code></li><li>Second item</li></ul><a href="https://example.invalid/compare">Compare</a><br><em>updated</em>',
		);
		expect(value).toContain("Added **2** commits");
		expect(value).toContain("- `develop`");
		expect(value).toContain("- Second item");
		expect(value).toContain("[Compare](https://example.invalid/compare)");
		expect(value).toContain("_updated_");
	});

	test("handles code blocks, details, entities and relative links", () => {
		const value = providerMarkdown(
			'&lt;root&gt; &amp; branch<br><details><summary>Details</summary><pre><code>const x = 1 &amp; 2;</code></pre><a href="/internal">Internal</a></details>',
		);
		expect(value).toContain("<root> & branch");
		expect(value).toContain("### Details");
		expect(value).toContain("```\nconst x = 1 & 2;\n```");
		expect(value).toContain("Internal");
		expect(value).not.toContain("href=");
	});

	test("leaves ordinary Markdown alone apart from entity decoding", () => {
		expect(providerMarkdown("# Title\n\nA &amp; B **bold** `code`")).toBe(
			"# Title\n\nA & B **bold** `code`",
		);
	});
});
