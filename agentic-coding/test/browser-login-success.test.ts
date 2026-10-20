// The declared login success condition must never hold on a page that is not an
// http(s) page: a refused or failed navigation (the browser's error page, a
// blank page) has the origin `null`, which differs from every identity provider
// and used to read as "left the IdP, so logged in" (a stage test reported
// `login:ok` three times while the session was logged out).
import { describe, expect, test } from "bun:test";
import { declaredSuccessHolds } from "../src/server/browser/login.ts";
import type { BrowserSession } from "../src/server/browser/session.ts";
import type { StageLoginRecipe } from "../src/server/stages/schema.ts";

const ENTRA = "https://login.microsoftonline.com";
const recipe: StageLoginRecipe = {
	kind: "interactive",
	origin: ENTRA,
	success: { notOrigin: ENTRA },
};

const sessionAt = (url: string) => ({ url }) as unknown as BrowserSession;

describe("declaredSuccessHolds notOrigin", () => {
	test("holds on an http(s) page of another origin", async () => {
		expect(
			await declaredSuccessHolds({
				session: sessionAt("https://app.example.test/home"),
				recipe,
			}),
		).toBe(true);
	});

	test("does not hold on the identity provider itself", async () => {
		expect(
			await declaredSuccessHolds({
				session: sessionAt(`${ENTRA}/tenant/oauth2/authorize`),
				recipe,
			}),
		).toBe(false);
	});

	test.each([
		"chrome-error://chromewebdata/",
		"about:blank",
		"null/",
		"",
		"data:text/html,x",
	])("does not hold on a non-http page %p", async (url) => {
		expect(
			await declaredSuccessHolds({ session: sessionAt(url), recipe }),
		).toBe(false);
	});
});
