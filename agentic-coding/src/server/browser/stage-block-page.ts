// The StageContext browser surface over one BrowserSession. Blocks never see a
// Playwright page or a server handle: every action goes through the same
// session validation (ref lifetime, stage origin guard, stage-action limits) as
// the browser tools.

import {
	DATA_BLOCK_MAX_DELAY_MS,
	DATA_BLOCK_MAX_TEXT,
} from "../../stage-blocks/data-block.ts";
import type {
	BlockAssertion,
	BlockLocator,
	BlockPage,
} from "../../stage-blocks/define-block.ts";
import type { BrowserSession } from "./session.ts";

const RESOLVE_LIMIT = 20;
const EXPECT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectorForTestId(testId: string): string {
	return `[data-testid=${JSON.stringify(testId)}]`;
}

function selectorForText(text: string, exact: boolean | undefined): string {
	return exact === true ? `text=${JSON.stringify(text)}` : `text=${text}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One locator shape: either a Playwright selector (stable, cheap) or an
 * accessible role/name that is resolved against the current AI snapshot. */
type LocatorSpec =
	| { readonly kind: "selector"; readonly selector: string }
	| {
			readonly kind: "accessible";
			readonly role?: string;
			readonly name?: string;
			readonly preferRoles?: readonly string[];
	  };

export class SessionBlockPage implements BlockPage {
	constructor(
		private readonly session: BrowserSession,
		private readonly options: {
			readonly timeoutMs?: number;
			readonly assertUrl?: (url: string) => void;
		} = {},
	) {}

	private get timeoutMs(): number {
		return this.options.timeoutMs ?? 10_000;
	}

	async goto(url: string): Promise<void> {
		this.options.assertUrl?.(url);
		this.session.invalidateSnapshot();
		await this.session.goto(url, this.timeoutMs);
	}

	url(): string {
		return this.session.url;
	}

	async title(): Promise<string> {
		return await this.session.title();
	}

	async reload(): Promise<void> {
		await this.goto(this.session.url);
	}

	async waitForTimeout(ms: number): Promise<void> {
		await sleep(Math.max(0, Math.min(ms, 60_000)));
	}

	getByRole(
		role: string,
		options?: { name?: string; exact?: boolean },
	): BlockLocator {
		return this.locatorOf({
			kind: "accessible",
			role,
			...(options?.name === undefined ? {} : { name: options.name }),
		});
	}

	getByLabel(label: string): BlockLocator {
		return this.locatorOf({
			kind: "accessible",
			name: label,
			preferRoles: [
				"textbox",
				"searchbox",
				"combobox",
				"checkbox",
				"radio",
				"spinbutton",
				"button",
			],
		});
	}

	getByTestId(testId: string): BlockLocator {
		return this.locatorOf({
			kind: "selector",
			selector: selectorForTestId(testId),
		});
	}

	getByText(text: string, options?: { exact?: boolean }): BlockLocator {
		return this.locatorOf({
			kind: "selector",
			selector: selectorForText(text, options?.exact),
		});
	}

	locator(selector: string): BlockLocator {
		if (selector.trim() === "")
			throw new Error("block-locator: a selector cannot be empty");
		return this.locatorOf({ kind: "selector", selector });
	}

	private locatorOf(spec: LocatorSpec): BlockLocator {
		return {
			click: async () => {
				await this.session.click(await this.targetOf(spec), this.timeoutMs);
				this.session.invalidateSnapshot();
			},
			fill: async (value) => {
				await this.session.fill(
					await this.targetOf(spec),
					value,
					this.timeoutMs,
				);
				this.session.invalidateSnapshot();
			},
			type: async (value, options) => {
				// The same bounds a data block's `type` action validates against, so a
				// checked-in block cannot hang the run by typing an unbounded string
				// or pausing between every keystroke.
				if (value.length > DATA_BLOCK_MAX_TEXT)
					throw new Error(
						`type value is ${value.length} characters; the bound is ${DATA_BLOCK_MAX_TEXT}`,
					);
				const delayMs = options?.delayMs ?? 0;
				if (delayMs < 0 || delayMs > DATA_BLOCK_MAX_DELAY_MS)
					throw new Error(
						`type delay ${delayMs} ms is outside 0-${DATA_BLOCK_MAX_DELAY_MS}`,
					);
				await this.session.pressSequentially(await this.targetOf(spec), value, {
					...(options?.delayMs === undefined
						? {}
						: { delayMs: options.delayMs }),
					timeoutMs: this.timeoutMs,
				});
				this.session.invalidateSnapshot();
			},
			press: async (key) => {
				await this.session.press(
					key,
					await this.targetOf(spec),
					this.timeoutMs,
				);
				this.session.invalidateSnapshot();
			},
			selectOption: async (values) => {
				await this.session.select(
					await this.targetOf(spec),
					typeof values === "string" ? [values] : values,
					this.timeoutMs,
				);
				this.session.invalidateSnapshot();
			},
			textContent: async () =>
				await this.session.textContent(
					await this.targetOf(spec),
					this.timeoutMs,
				),
			innerText: async () => {
				const text = await this.session.textContent(
					await this.targetOf(spec),
					this.timeoutMs,
				);
				return text ?? "";
			},
			isVisible: async () => {
				try {
					await this.session.wait({
						target: await this.targetOf(spec),
						timeoutMs: 1_000,
					});
					return true;
				} catch {
					return false;
				}
			},
			waitFor: async (options) => {
				if (options?.state === "hidden")
					throw new Error(
						"block-locator: the hidden wait state is not available through the session facade; assert the absence with isVisible() instead",
					);
				await this.session.wait({
					target: await this.targetOf(spec),
					timeoutMs: this.timeoutMs,
				});
			},
		};
	}

	private async targetOf(
		spec: LocatorSpec,
	): Promise<{ ref: string } | { selector: string }> {
		if (spec.kind === "selector") return { selector: spec.selector };
		return { ref: await this.refOf(spec) };
	}

	private async refOf(spec: {
		readonly role?: string;
		readonly name?: string;
		readonly preferRoles?: readonly string[];
	}): Promise<string> {
		if (this.session.snapshotRequired || this.session.snapshotInvalid)
			await this.session.snapshot();
		const found = await this.session.findSnapshot({
			query: spec.name ?? spec.role ?? "",
			...(spec.role === undefined ? {} : { role: spec.role }),
			...(spec.name === undefined ? {} : { name: spec.name }),
			limit: RESOLVE_LIMIT,
		});
		const preferred =
			spec.preferRoles === undefined
				? undefined
				: found.matches.find((match) => spec.preferRoles?.includes(match.role));
		const match =
			preferred ??
			(spec.name === undefined
				? found.matches[0]
				: (found.matches.find((entry) => entry.name === spec.name) ??
					found.matches[0]));
		if (match === undefined)
			throw new Error(
				`block-locator-missing: no ${spec.role ?? "control"}${
					spec.name === undefined ? "" : ` named ${JSON.stringify(spec.name)}`
				} is present in the current snapshot`,
			);
		if (match.ref === undefined)
			throw new Error("block-locator: the matched node has no actionable ref");
		return match.ref;
	}
}

/** The two assertions blocks actually need, implemented without exposing a raw
 * Playwright expect handle. Reads are retried within the bounded timeout because
 * a save toast or reload often lands a fraction after the click. */
export function sessionExpect(locator: BlockLocator): BlockAssertion {
	return {
		toContainText: async (expected) => {
			const deadline = Date.now() + EXPECT_TIMEOUT_MS;
			let observed = "";
			while (Date.now() < deadline) {
				try {
					observed = (await locator.textContent()) ?? "";
					if (observed.includes(expected)) return;
				} catch (error) {
					observed = messageOf(error);
				}
				await sleep(POLL_MS);
			}
			throw new Error(
				`block-assertion: expected ${JSON.stringify(expected)} in text, observed ${JSON.stringify(observed)}`,
			);
		},
		toBeVisible: async () => {
			const deadline = Date.now() + EXPECT_TIMEOUT_MS;
			while (Date.now() < deadline) {
				try {
					if (await locator.isVisible()) return;
				} catch {
					// The page may still be navigating; retry until the bound.
				}
				await sleep(POLL_MS);
			}
			throw new Error("block-assertion: the element did not become visible");
		},
	};
}
