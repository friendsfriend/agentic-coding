// Pilot blocks for the customer-address flow.
//
// These are intentionally ordinary, readable functions. They use only the
// StageContext allow-list, so the same source runs against the plan runner and
// the generated Playwright fixture. A stage application may replace the labels
// and test ids with its own stable ones; the contract (inputs, effects and
// postcondition) is what callers depend on.

import { defineBlock } from "../define-block.ts";

const CUSTOMER_DETAIL = "customer-detail";
const CUSTOMER_ADDRESS = "customer-address";
const ADDRESS_SAVED = "address-saved";
const SESSION_USER = "session-user";

function argText(
	args: Record<string, import("../schema.ts").JsonValue>,
	name: string,
	fallback?: string,
): string {
	const value = args[name];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${name} is required`);
	return value;
}

export const loginAsRole = defineBlock({
	id: "crm.auth.loginAsRole",
	version: "1.0.0",
	app: "crm",
	title: "Sign in as a stage role",
	exportName: "loginAsRole",
	description:
		"Signs in through the stage login form using values resolved from the configuration `.env`, then waits for the signed-in indicator.",
	params: {
		type: "object",
		additionalProperties: false,
		properties: {
			role: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description: "The declared stage role this session is signing in as.",
			},
			usernameSecret: {
				type: "string",
				minLength: 1,
				maxLength: 256,
				default: "STAGE_USERNAME",
				description: "The `.env` variable that holds the username.",
			},
			passwordSecret: {
				type: "string",
				minLength: 1,
				maxLength: 256,
				default: "STAGE_PASSWORD",
				description: "The `.env` variable that holds the password.",
			},
			signedInTestId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				default: SESSION_USER,
				description: "A stable signed-in indicator on the landing page.",
			},
		},
		required: ["role"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: {
			role: { type: "string" },
			url: { type: "string" },
		},
		required: ["role", "url"],
	},
	effects: ["read"],
	idempotent: false,
	provides: ["logged-in"],
	examples: [
		{ role: "clerk" },
		{
			role: "clerk",
			usernameSecret: "CRM_STAGE_USER",
			passwordSecret: "CRM_STAGE_PASSWORD",
		},
	],
	contractTest: "test/stage-blocks.test.ts",
	run: async (ctx, args) => {
		const role = argText(args, "role");
		await ctx.step("sign in as the requested role", async () => {
			await ctx.page
				.getByLabel("Username")
				.fill(ctx.secret(argText(args, "usernameSecret", "STAGE_USERNAME")));
			await ctx.page
				.getByLabel("Password")
				.fill(ctx.secret(argText(args, "passwordSecret", "STAGE_PASSWORD")));
			await ctx.page.getByRole("button", { name: "Sign in" }).click();
			await ctx
				.expect(
					ctx.page.getByTestId(argText(args, "signedInTestId", SESSION_USER)),
				)
				.toBeVisible();
			if (ctx.page.url().includes("/login"))
				throw new Error("the login form is still showing after sign in");
			return undefined;
		});
		await ctx.step("confirm the signed-in role", async () => {
			await ctx
				.expect(
					ctx.page.getByTestId(argText(args, "signedInTestId", SESSION_USER)),
				)
				.toContainText(role);
			return undefined;
		});
		return { role, url: ctx.page.url() };
	},
});

export const openUiPath = defineBlock({
	id: "crm.ui.open",
	version: "1.0.0",
	app: "crm",
	title: "Open an application path",
	exportName: "openUiPath",
	description:
		"Navigates within the application to one relative path and optionally waits for a stable ready marker. It never accepts an absolute URL, so it cannot leave the stage's application origin.",
	params: {
		type: "object",
		additionalProperties: false,
		properties: {
			path: {
				type: "string",
				minLength: 1,
				maxLength: 2048,
				pattern: "^/(?!/)",
				description: "An application-relative path beginning with one slash.",
			},
			readyTestId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description: "Optional stable marker that must be visible after load.",
			},
		},
		required: ["path"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: { url: { type: "string" } },
		required: ["url"],
	},
	effects: ["read"],
	idempotent: true,
	examples: [
		{ path: "/" },
		{ path: "/customers/C-1001", readyTestId: CUSTOMER_DETAIL },
	],
	contractTest: "test/stage-blocks.test.ts",
	run: async (ctx, args) => {
		const path = argText(args, "path");
		if (!path.startsWith("/") || path.startsWith("//"))
			throw new Error("path must be application-relative and begin with one /");
		await ctx.step("open the application path", async () => {
			const base = ctx.appUrl.replace(/\/+$/, "");
			await ctx.page.goto(`${base}${path}`);
			const ready =
				args.readyTestId === undefined
					? undefined
					: ctx.page.getByTestId(argText(args, "readyTestId"));
			if (ready !== undefined) await ctx.expect(ready).toBeVisible();
			return undefined;
		});
		return { url: ctx.page.url() };
	},
});

export const openCustomer = defineBlock({
	id: "crm.customer.open",
	version: "1.0.0",
	app: "crm",
	title: "Open a customer",
	exportName: "openCustomer",
	description:
		"Navigates to one customer's detail page and verifies that the requested customer is the one on screen.",
	params: {
		type: "object",
		additionalProperties: false,
		properties: {
			customerId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description: "The customer's stable stage-test identifier.",
			},
		},
		required: ["customerId"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: {
			customerId: { type: "string" },
			url: { type: "string" },
		},
		required: ["customerId", "url"],
	},
	effects: ["read"],
	idempotent: true,
	requires: ["logged-in"],
	provides: ["customer-open"],
	examples: [{ customerId: "C-1001" }, { customerId: "C-2002" }],
	contractTest: "test/stage-blocks.test.ts",
	run: async (ctx, args) => {
		const customerId = argText(args, "customerId");
		await ctx.step("open the customer detail page", async () => {
			const base = ctx.appUrl.replace(/\/+$/, "");
			await ctx.page.goto(
				`${base}/customers/${encodeURIComponent(customerId)}`,
			);
			const detail = ctx.page.getByTestId(CUSTOMER_DETAIL);
			await ctx.expect(detail).toBeVisible();
			await ctx.expect(detail).toContainText(customerId);
			return undefined;
		});
		return { customerId, url: ctx.page.url() };
	},
});

export const fillCustomerAddress = defineBlock({
	id: "crm.customer.fillAddress",
	version: "1.0.0",
	app: "crm",
	title: "Fill and save a customer address",
	exportName: "fillCustomerAddress",
	description:
		"Fills the address form of the open customer, saves it, reloads the page and verifies the saved values survived the reload.",
	params: {
		type: "object",
		additionalProperties: false,
		properties: {
			customerId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description: "The customer whose address is edited.",
			},
			street: {
				type: "string",
				minLength: 1,
				maxLength: 256,
				description: "Street and house number.",
			},
			city: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				description: "City.",
			},
			postalCode: {
				type: "string",
				minLength: 1,
				maxLength: 32,
				description: "Postal code.",
			},
			country: {
				type: "string",
				minLength: 2,
				maxLength: 2,
				default: "DE",
				description: "Two-letter country code.",
			},
		},
		required: ["customerId", "street", "city", "postalCode"],
	},
	returns: {
		type: "object",
		additionalProperties: false,
		properties: {
			customerId: { type: "string" },
			street: { type: "string" },
			city: { type: "string" },
			postalCode: { type: "string" },
			country: { type: "string" },
			url: { type: "string" },
		},
		required: ["customerId", "street", "city", "postalCode", "country", "url"],
	},
	effects: ["write"],
	idempotent: false,
	requires: ["logged-in", "customer-open"],
	provides: ["customer-address-saved"],
	examples: [
		{
			customerId: "C-1001",
			street: "Teststr. 1",
			city: "Berlin",
			postalCode: "10115",
			country: "DE",
		},
	],
	contractTest: "test/stage-blocks.test.ts",
	run: async (ctx, args) => {
		const customerId = argText(args, "customerId");
		const street = argText(args, "street");
		const city = argText(args, "city");
		const postalCode = argText(args, "postalCode");
		const country = argText(args, "country", "DE");
		await ctx.step("fill the address", async () => {
			await ctx.page.getByLabel("Street").fill(street);
			await ctx.page.getByLabel("City").fill(city);
			await ctx.page.getByLabel("Postal code").fill(postalCode);
			await ctx.page.getByLabel("Country").fill(country);
			return undefined;
		});
		await ctx.step("save the address", async () => {
			await ctx.page.getByRole("button", { name: "Save address" }).click();
			await ctx.expect(ctx.page.getByTestId(ADDRESS_SAVED)).toBeVisible();
			return undefined;
		});
		await ctx.step("reload and verify the saved address", async () => {
			await ctx.page.reload();
			const detail = ctx.page.getByTestId(CUSTOMER_ADDRESS);
			await ctx.expect(detail).toBeVisible();
			await ctx.expect(detail).toContainText(street);
			await ctx.expect(detail).toContainText(city);
			await ctx.expect(detail).toContainText(postalCode);
			return undefined;
		});
		return {
			customerId,
			street,
			city,
			postalCode,
			country,
			url: ctx.page.url(),
		};
	},
});

export const pilotBlocks = [
	loginAsRole,
	openUiPath,
	openCustomer,
	fillCustomerAddress,
] as const;
