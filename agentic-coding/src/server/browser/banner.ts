// The hand-off banner (`add-stage-interactive-login`, task 3.5).
//
// While a hand-off is active the developer is looking at a real window, so the
// page itself has to say what the window is for: which stage, which application
// and which role the login belongs to, and that the run is waiting. The banner
// is installed as a *context-level init script*, so it is there on every
// document of the session, including the IdP redirect that performs the login.
//
// Two properties matter and both are why this is a script rather than markup:
//
// * It is inside a **closed shadow root**. The page can neither style it nor
//   read it, and an agent selector cannot reach into it, so the banner cannot
//   become a ref an agent acts on.
// * It carries **no value**: the stage, application and role are configuration
//   names, never a credential, and the banner never reads the page.
//
// The banner text is the only thing this module interpolates, and it is
// JSON-encoded into the script so a stage name can never break out of it.

/** Where the banner host element lives; a single id keeps the install and the
 * removal in step. */
const BANNER_HOST_ID = "agentic-coding-login-handoff-banner";

export interface HandoffBannerText {
	readonly stage: string;
	readonly app: string;
	readonly role: string;
	/** Why the window was opened, as the coordinator's reason code. */
	readonly reason: string;
	/** When the hand-off ends, as a local wall-clock time with its remainder
	 * (`formatHandoffDeadline`): this is read by a person, not by a machine. */
	readonly deadline: string;
	/** Whether the run raised the dashboard dialog at all. A record the run
	 * refused means there is no *Done* to choose, and a banner that promises one
	 * leaves the developer waiting for a button that never renders (USAB-105). */
	readonly canConfirm: boolean;
}

/** The sentence the banner shows. Plain data, no credential, no URL. */
export function handoffBannerText(text: HandoffBannerText): string {
	const reason =
		text.reason === "no-credentials"
			? "this role declares no credentials this server can use"
			: "this login needs a step the server cannot automate";
	const ending = text.canConfirm
		? `The agent is waiting for this login. Sign in in this window, then choose Done in the dashboard; closing this window aborts the hand-off. It expires at ${text.deadline}.`
		: `The agent is waiting for this login. Sign in in this window; the hand-off ends when the login is detected or at ${text.deadline}, and closing this window aborts it.`;
	return `Login hand-off: ${text.stage} · ${text.app} · ${text.role} — ${reason}. ${ending}`;
}

/** The init script installed on the promoted context while a hand-off is
 * active. Idempotent: a document that renders it twice keeps one banner. */
export function bannerScript(text: HandoffBannerText): string {
	const message = JSON.stringify(handoffBannerText(text));
	return `(() => {
	const id = ${JSON.stringify(BANNER_HOST_ID)};
	if (document.getElementById(id)) return;
	const host = document.createElement("div");
	host.id = id;
	host.setAttribute("data-ac-handoff-banner", "1");
	host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;right:0;all:initial;pointer-events:none;position:fixed;top:0;left:0;right:0;z-index:2147483647;";
	const root = host.attachShadow({ mode: "closed" });
	const bar = document.createElement("div");
	// Nothing in the banner is interactive by design, so it never claims a click:
	// the band it covers is where a real login page puts its own controls.
	bar.style.cssText = "font:13px/1.4 -apple-system,system-ui,sans-serif;background:#1b1b1f;color:#f5f5f7;padding:6px 10px;border-bottom:2px solid #f0b429;text-align:left;pointer-events:none;";
	bar.textContent = ${message};
	root.appendChild(bar);
	const attach = () => document.body && document.body.appendChild(host);
	if (document.body) attach();
	else document.addEventListener("DOMContentLoaded", attach, { once: true });
})();`;
}

/** The page-level removal call: what a finished hand-off runs in the live page,
 * because an installed init script cannot be uninstalled for documents that are
 * already open (Playwright has no `removeInitScript`). */
export function bannerRemovalScript(): string {
	return `(() => { const host = document.getElementById(${JSON.stringify(BANNER_HOST_ID)}); if (host) host.remove(); })();`;
}

/** The removal is a plain expression so a driver can also run it on a page that
 * has not navigated yet. `install.ts` never sees this; the pool does. */
export const BANNER_HOST = BANNER_HOST_ID;
