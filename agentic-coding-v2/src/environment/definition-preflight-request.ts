import { digest, text } from "../config.ts";

const modes = [
	"readComposeSource",
	"useStagedSource",
	"compareSourceBase",
	"validateStagedCandidate",
	"materializeStagedTree",
] as const;
const selectedModes = [
	"readComposeSource",
	"useStagedSource",
	"compareSourceBase",
] as const;
function preflightMode(body: Record<string, unknown>) {
	const allowed = [
		"requestId",
		"id",
		"revision",
		"digest",
		"app",
		"target",
		...modes,
		"retainStagedTree",
	];
	if (Object.keys(body).some((key) => !allowed.includes(key)))
		throw new Error("Unsupported preflight field");
	const active = modes.filter((mode) => body[mode] !== undefined);
	if (active.length > 1 || active.some((mode) => body[mode] !== true))
		throw new Error(
			"Choose exactly one explicit true preflight mode; source modes cannot be combined",
		);
	const mode = active[0];
	if (
		body.retainStagedTree !== undefined &&
		(mode !== "materializeStagedTree" || body.retainStagedTree !== true)
	)
		throw new Error(
			"Retaining a staged tree requires the explicit tree mode set to true",
		);
	if (
		(!mode || !(selectedModes as readonly (typeof mode)[]).includes(mode)) &&
		(body.app !== undefined || body.target !== undefined)
	)
		throw new Error(
			"Only selected-source modes accept exact app/target fields",
		);
	return mode;
}
/** Request routing/identity only, no observations, filesystem or authority. */
export function preflightRequest(body: Record<string, unknown>) {
	const mode = preflightMode(body),
		requestId = text(body.requestId, "preflight request ID", 128),
		id = text(body.id, "draft ID", 80),
		contentDigest = text(body.digest, "draft digest", 64);
	if (!/^draft-[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid definition draft ID");
	if (
		!/^[a-f0-9]{64}$/.test(contentDigest) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Preflight requires exact draft revision and digest");
	const candidate = mode === "validateStagedCandidate",
		tree = mode === "materializeStagedTree",
		selection =
			mode && (selectedModes as readonly (typeof mode)[]).includes(mode)
				? {
						[mode]: true,
						app: text(body.app, "source app", 128),
						target: text(body.target, "source target", 128),
					}
				: null,
		binding = { id, revision: body.revision, digest: contentDigest };
	// Keep prior metadata and selected-source request hash property order exactly.
	const request = digest(
		JSON.stringify(
			candidate || tree
				? {
						...binding,
						...(candidate
							? { validateStagedCandidate: true }
							: {
									materializeStagedTree: true,
									...(body.retainStagedTree === true
										? { retainStagedTree: true }
										: {}),
								}),
					}
				: selection
					? { ...binding, ...selection }
					: binding,
		),
	);
	return {
		id,
		contentDigest,
		candidate,
		tree,
		retain: body.retainStagedTree === true,
		compareBase: mode === "compareSourceBase",
		stagedSource: mode === "useStagedSource",
		selection,
		request,
		key: digest(requestId),
	};
}
