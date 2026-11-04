import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import { validateProjects } from "./catalog.ts";

type Base = {
	destination: string;
	state: "absent" | "regular";
	digest?: string;
};
type Draft = {
	id: string;
	revision: number;
	content: string;
	digest: string;
	base: Base;
};
type Receipt = {
	request: string;
	result: { id: string; revision: number; digest: string };
};
const DraftState = defineDoc<{
	drafts: Record<string, string>;
	receipts: Record<string, string>;
}>({
	kind: "v2.environment-drafts",
	version: 1,
	scope: "session",
	initial: () => ({ drafts: {}, receipts: {} }),
	checkpointWhen: () => true,
});
function stored<T>(value: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(
			"Private draft state is malformed; contents and parser errors are withheld",
		);
	}
}
const parseDraft = (value: string) => stored<Draft>(value);

function base(config: Config): Base {
	const destination = path.join(config.configDir, "environments.json");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { destination, state: "absent" };
		throw new Error("Definition base is unavailable");
	}
	if (!stat.isFile() || stat.size > 65536)
		throw new Error(
			"Draft base requires a regular environments.json of at most 64 KiB; symlinks are unsupported",
		);
	const fd = fs.openSync(
		destination,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd),
			buffer = Buffer.alloc(65537);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			opened.size > 65536
		)
			throw new Error("Definition base changed");
		let length = 0;
		while (length < buffer.length) {
			const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (!n) break;
			length += n;
		}
		const after = fs.fstatSync(fd),
			current = fs.lstatSync(destination);
		if (
			length > 65536 ||
			!current.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			opened.size !== after.size ||
			opened.mtimeMs !== after.mtimeMs ||
			opened.ctimeMs !== after.ctimeMs
		)
			throw new Error("Definition base changed");
		return {
			destination,
			state: "regular",
			digest: digest(buffer.subarray(0, length)),
		};
	} finally {
		fs.closeSync(fd);
	}
}
function within(parent: string, child: string) {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}
function privateState(config: Config) {
	const root = fs.realpathSync(config.stateDir),
		stat = fs.statSync(root);
	let native = root;
	try {
		native = fs.realpathSync(path.join(root, "native"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Native draft storage is unavailable");
	}
	if (
		!stat.isDirectory() ||
		(stat.mode & 0o077) !== 0 ||
		!within(root, native) ||
		config.repositories.some(
			(repo) => within(repo, root) || within(repo, native),
		)
	)
		throw new Error(
			"Drafts require a private native state directory outside every authorized repository",
		);
}
function schema(config: Config, draft: Draft) {
	const binding = {
		contentDigest: draft.digest,
		repositoryDigest: digest(JSON.stringify(config.repositories)),
		scope: "schema-only",
	};
	try {
		validateProjects(config, JSON.parse(draft.content));
		return {
			...binding,
			valid: true,
			message:
				"Native v1 schema accepted. Referenced files, sources, defaults/availability and runtime effects have NOT been validated. No execution or promotion authority.",
		};
	} catch {
		return {
			...binding,
			valid: false,
			message:
				"JSON/native v1 schema rejected. Check fields, target/dependency constraints and exact authorized repository paths. Values and parser errors are withheld.",
		};
	}
}
/** Private native documents are staged data, never reviews, runnable targets or
 * restored execution authority. No content is included in environment snapshots. */
export class DefinitionDrafts {
	constructor(
		private config: Config,
		private engine: () => Harness,
	) {}
	async list() {
		privateState(this.config);
		const doc = await this.engine().snapshot(DraftState, background);
		return Object.values(doc?.drafts ?? {}).map((value) => {
			const { id, revision, digest } = parseDraft(value);
			return { id, revision, digest };
		});
	}
	async read(id: string) {
		privateState(this.config);
		this.id(id);
		const doc = await this.engine().snapshot(DraftState, background),
			raw = doc?.drafts[id];
		if (!raw) throw new Error("Unknown definition draft");
		const draft = parseDraft(raw);
		let baseMatches: boolean | null = null;
		try {
			baseMatches =
				JSON.stringify(draft.base) === JSON.stringify(base(this.config));
		} catch {
			/* Unavailable is not unchanged. */
		}
		return {
			...draft,
			schema: schema(this.config, draft),
			baseMatches,
			authority:
				"Staged text only. Base comparison is an observation, never a promotion fence. No runtime validation, approval or promotion.",
		};
	}
	private id(value: string) {
		if (!/^draft-[a-f0-9]{64}$/.test(value))
			throw new Error("Invalid definition draft ID");
	}
	async save(body: Record<string, unknown>) {
		privateState(this.config);
		if (
			Object.keys(body).some(
				(key) => !["requestId", "content", "id", "revision"].includes(key),
			)
		)
			throw new Error("Unsupported draft field");
		const requestId = text(body.requestId, "draft request ID", 128),
			content = text(body.content, "draft content", 65536);
		if (Buffer.byteLength(content) > 65536)
			throw new Error("Draft content exceeds 64 KiB");
		const editing = body.id !== undefined;
		const id = editing
			? text(body.id, "draft ID", 80)
			: `draft-${digest(requestId)}`;
		this.id(id);
		if (
			editing
				? !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
				: body.revision !== undefined
		)
			throw new Error(
				"Saving an existing draft requires its exact positive revision; creation must omit it",
			);
		const request = digest(
				JSON.stringify({ id, revision: body.revision ?? null, content }),
			),
			key = digest(requestId);
		return this.engine().commit(async (tx) => {
			const doc = await tx.doc(DraftState),
				recorded = doc.receipts[key];
			if (recorded) {
				const receipt = stored<Receipt>(recorded);
				if (receipt.request !== request)
					throw new Error(
						"Draft request ID was reused for different content or revision",
					);
				return receipt.result;
			}
			if (Object.keys(doc.receipts).length >= 256)
				throw new Error(
					"Native draft receipt capacity reached; automatic pruning is unsupported",
				);
			const raw = doc.drafts[id],
				previous = raw ? parseDraft(raw) : null;
			if (
				editing
					? !previous || previous.revision !== body.revision
					: previous !== null
			)
				throw new Error(
					"Draft revision conflict; load the current draft explicitly before saving",
				);
			if (!editing && Object.keys(doc.drafts).length >= 16)
				throw new Error(
					"Native draft capacity reached; automatic pruning is unsupported",
				);
			const draft: Draft = {
				id,
				revision: (previous?.revision ?? 0) + 1,
				content,
				digest: digest(content),
				base: previous?.base ?? base(this.config),
			};
			const result = { id, revision: draft.revision, digest: draft.digest };
			doc.drafts[id] = JSON.stringify(draft);
			doc.receipts[key] = JSON.stringify({ request, result });
			return result;
		}, background);
	}
}
