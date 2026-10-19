// `agentic-coding stage …` — the operator's view of the stage identity cache
// (`add-stage-identity-cache`, task 3.1).
//
// Two things, both value-free:
//
//   agentic-coding stage identity list [--stage S] [--role R] [--json]
//   agentic-coding stage identity forget [--stage S] [--role R] [--all]
//
// The cache lives in the *server's* memory, so this command is a client of a
// running server (the shell's own client, or the handoff env a parent shell
// exports) and never reads a file: there is no file. Without a connected server
// the command says so instead of printing an empty list, because "no server" and
// "no cached identity" are different answers.
import type {
	StageIdentitiesResponse,
	StageIdentityForgetResponse,
	StageIdentityStatus,
} from "../../contracts/stages.ts";
import {
	BackendClientError,
	backendClient,
	backendClientFromEnv,
} from "../client.ts";
import {
	STAGES_IDENTITY_FORGET_PATH,
	STAGES_IDENTITY_PATH,
} from "../protocol.ts";

const USAGE = [
	"Usage: agentic-coding stage identity <list|forget> [options]",
	"",
	"  list                       live cached identities: stage, role, captured, expires",
	"  forget                     forget one stage's cached identity",
	"",
	"Options:",
	"  --stage <ident>            restrict to one stage",
	"  --role <role>              restrict to one role of that stage",
	"  --all                      forget every cached identity (forget only)",
	"  --json                     print the raw value-free JSON",
].join("\n");

/** One parsed invocation. */
interface ParsedStageCommand {
	readonly action: "list" | "forget";
	readonly stage?: string;
	readonly role?: string;
	readonly all: boolean;
	readonly json: boolean;
}

export function parseStageCommand(
	argv: readonly string[],
): ParsedStageCommand | undefined {
	if (argv[0] !== "identity") return undefined;
	const action = argv[1];
	if (action !== "list" && action !== "forget") return undefined;
	let stage: string | undefined;
	let role: string | undefined;
	let all = false;
	let json = false;
	for (let index = 2; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--stage" && value !== undefined) {
			stage = value;
			index += 1;
			continue;
		}
		if (flag === "--role" && value !== undefined) {
			role = value;
			index += 1;
			continue;
		}
		if (flag === "--all") {
			all = true;
			continue;
		}
		if (flag === "--json") {
			json = true;
			continue;
		}
		return undefined;
	}
	// A role names an identity of one stage: without a stage there is nothing it
	// could restrict, and guessing a stage would forget the wrong one.
	if (role !== undefined && stage === undefined) return undefined;
	if (action === "forget" && stage === undefined && !all) return undefined;
	return {
		action,
		...(stage === undefined ? {} : { stage }),
		...(role === undefined ? {} : { role }),
		all,
		json,
	};
}

/** The connected server, or `undefined` when this shell has none. */
function connectedClient() {
	return backendClient() ?? backendClientFromEnv();
}

async function readValue<T>(response: Response): Promise<T> {
	const parsed = (await response.json().catch(() => undefined)) as
		| { ok?: boolean; value?: unknown; error?: { message?: string } }
		| undefined;
	if (!response.ok || !parsed || parsed.error)
		throw new BackendClientError(
			response.status,
			"request-failed",
			parsed?.error?.message ?? `the server answered ${response.status}`,
		);
	return parsed.value as T;
}

/** Run one `stage` command, answering the process exit code. */
export async function stageCommand(argv: readonly string[]): Promise<number> {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		console.log(USAGE);
		return 0;
	}
	const parsed = parseStageCommand(argv);
	if (!parsed) {
		console.error(USAGE);
		return 2;
	}
	const client = connectedClient();
	if (!client) {
		console.error(
			"no connected server: a stage identity lives in the server process's memory, so start a server (or run this from a shell that has one) and try again",
		);
		return 1;
	}
	const headers: Record<string, string> = {
		authorization: `Bearer ${client.token}`,
	};
	try {
		if (parsed.action === "list") {
			const value = await readValue<StageIdentitiesResponse>(
				await fetch(`${client.baseUrl}${STAGES_IDENTITY_PATH}`, { headers }),
			);
			printIdentities(value.entries, parsed);
			return 0;
		}
		const value = await readValue<StageIdentityForgetResponse>(
			await fetch(`${client.baseUrl}${STAGES_IDENTITY_FORGET_PATH}`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({
					...(parsed.stage === undefined ? {} : { stage: parsed.stage }),
					...(parsed.role === undefined ? {} : { role: parsed.role }),
				}),
			}),
		);
		if (parsed.json) {
			console.log(JSON.stringify(value, null, 2));
			return 0;
		}
		console.log(
			value.removed === 0
				? "no cached identity matched, so nothing was forgotten"
				: `forgot ${value.removed} cached identit${value.removed === 1 ? "y" : "ies"}; the next login runs the normal path`,
		);
		printIdentities(value.entries, parsed);
		return 0;
	} catch (error) {
		console.error(
			error instanceof Error
				? `stage identity: ${error.message}`
				: `stage identity: ${String(error)}`,
		);
		return 1;
	}
}

/** The listing, either as JSON or as one line per entry. The filter is applied
 * here as well as in the request: the route has no filter, so `--stage` narrows
 * what this command prints. */
function printIdentities(
	entries: readonly StageIdentityStatus[],
	parsed: ParsedStageCommand,
): void {
	const selected = entries.filter(
		(entry) =>
			(parsed.stage === undefined || entry.stage === parsed.stage) &&
			(parsed.role === undefined || entry.role === parsed.role),
	);
	if (parsed.json) {
		console.log(JSON.stringify({ entries: selected }, null, 2));
		return;
	}
	if (selected.length === 0) {
		console.log("no cached stage identity");
		return;
	}
	const now = Date.now();
	for (const entry of selected)
		console.log(
			`${entry.stage} ${entry.role} captured ${iso(entry.capturedAt)} expires ${iso(entry.expiresAt)} (in ${minutes(Math.max(0, entry.expiresAt - now))})${entry.truncated > 0 ? ` truncated ${entry.truncated} values` : ""}`,
		);
}

function iso(at: number): string {
	return new Date(at).toISOString();
}

function minutes(ms: number): string {
	return `${Math.max(0, Math.round(ms / 60_000))} min`;
}
