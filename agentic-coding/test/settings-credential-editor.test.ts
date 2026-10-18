// The masked credential editor's pure half (`add-stage-testing-foundation`,
// task 5.1): the one surface in Settings that takes a secret.
//
// The value a developer types is never echoed back — not to the shell, not to a
// log — so the rules that decide what the draft becomes are asserted here rather
// than through a rendered terminal: what a keystroke may add, and what a draft
// may be saved as.
import { describe, expect, test } from "bun:test";
import {
	acceptCredentialKeystroke,
	MAX_CREDENTIAL_CHARS,
	maskCredential,
	readCredentialDraft,
} from "../src/tui/settings/CredentialEditor.tsx";

describe("settings: credential editor", () => {
	test("a draft renders as one bullet per character and nothing else", () => {
		expect(maskCredential("")).toBe("");
		expect(maskCredential("hunter2")).toBe("•••••••");
		expect(maskCredential("hunter2")).not.toContain("h");
		// An emoji or a non-BMP character is one character, not two code units.
		expect(maskCredential("🔐")).toBe("•");
	});

	test("any printable keystroke is taken, and function keys are left alone", () => {
		// A credential is opaque: `?`, `$`, `{`, a slash and a space are all values.
		let draft = "";
		for (const key of ["?", "$", "{", "/", "%", "space", "a"])
			draft = acceptCredentialKeystroke(draft, key);
		expect(draft).toBe("?${/% a");
		// The shell's dispatch owns everything else.
		for (const key of ["return", "escape", "backspace", "tab", "up", ""])
			expect(acceptCredentialKeystroke(draft, key)).toBe(draft);
		// A pasted newline is a control code, not a value.
		expect(acceptCredentialKeystroke(draft, "\n")).toBe(draft);
	});

	test("a draft stops at the cap the route also enforces", () => {
		const full = "x".repeat(MAX_CREDENTIAL_CHARS);
		expect(acceptCredentialKeystroke(full, "y")).toBe(full);
		expect(acceptCredentialKeystroke(full, "space")).toBe(full);
		const almost = "x".repeat(MAX_CREDENTIAL_CHARS - 1);
		expect(acceptCredentialKeystroke(almost, "y")).toHaveLength(
			MAX_CREDENTIAL_CHARS,
		);
	});

	test("an empty draft is refused with a message, a value is passed through", () => {
		expect(readCredentialDraft("")).toEqual({
			ok: false,
			message: "enter a value",
		});
		expect(readCredentialDraft("   ")).toEqual({
			ok: false,
			message: "a credential cannot be only whitespace",
		});
		// Whitespace *inside* a value is part of it, and so is a trailing space:
		// the server never trims what this returns.
		expect(readCredentialDraft(" p@ss w0rd ")).toEqual({
			ok: true,
			value: " p@ss w0rd ",
		});
	});
});
