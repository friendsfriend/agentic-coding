import script from "../../web/app.js" with { type: "text" };
import authenticatedMessage from "../../web/authenticated-message.js" with {
	type: "text",
};
import discovery from "../../web/definition-discovery.js" with { type: "text" };
import drafts from "../../web/definition-drafts.js" with { type: "text" };
import definitionHistory from "../../web/definition-history.js" with {
	type: "text",
};
import promotionAttempts from "../../web/definition-promotion-attempts.js" with {
	type: "text",
};
import dom from "../../web/dom.js" with { type: "text" };
import databaseHistory from "../../web/environment-database-history.js" with {
	type: "text",
};
import diagnostics from "../../web/environment-diagnostics.js" with {
	type: "text",
};
import lifecycle from "../../web/environment-lifecycle.js" with {
	type: "text",
};
import telemetryView from "../../web/environment-telemetry-view.js" with {
	type: "text",
};
import html from "../../web/index.html" with { type: "text" };
import recordedDiagnostic from "../../web/recorded-diagnostic.js" with {
	type: "text",
};
import css from "../../web/style.css" with { type: "text" };

export function webAssets() {
	const assets = new Map([
		["/", { content: String(html), type: "text/html" }],
		["/app.js", { content: script, type: "text/javascript" }],
		[
			"/authenticated-message.js",
			{ content: authenticatedMessage, type: "text/javascript" },
		],
		["/dom.js", { content: dom, type: "text/javascript" }],
		["/definition-drafts.js", { content: drafts, type: "text/javascript" }],
		[
			"/definition-history.js",
			{ content: definitionHistory, type: "text/javascript" },
		],
		[
			"/definition-promotion-attempts.js",
			{ content: promotionAttempts, type: "text/javascript" },
		],
		[
			"/definition-discovery.js",
			{ content: discovery, type: "text/javascript" },
		],
		[
			"/recorded-diagnostic.js",
			{ content: recordedDiagnostic, type: "text/javascript" },
		],
		[
			"/environment-database-history.js",
			{ content: databaseHistory, type: "text/javascript" },
		],
		[
			"/environment-telemetry-view.js",
			{ content: telemetryView, type: "text/javascript" },
		],
		[
			"/environment-lifecycle.js",
			{ content: lifecycle, type: "text/javascript" },
		],
		[
			"/environment-diagnostics.js",
			{ content: diagnostics, type: "text/javascript" },
		],
		["/style.css", { content: css, type: "text/css" }],
	]);
	return assets;
}
