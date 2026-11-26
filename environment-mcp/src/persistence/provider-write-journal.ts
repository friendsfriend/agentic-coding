import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { OperationRefusal } from "../domain/operation.ts";
import type {
	ProviderWriteAction,
	ProviderWriteReceipt,
} from "../domain/provider.ts";

const byteLimit = 512 * 1024;
const writeLimit = 512;
const actionSchema = z.enum([
	"comment-change",
	"comment-issue",
	"approve-change",
	"merge-change",
	"set-issue-state",
	"rebase-change",
	"unapprove-change",
	"reply-discussion",
	"set-discussion-resolved",
	"add-labels",
	"set-assignees",
	"retry-pipeline",
	"retry-job",
	"cancel-pipeline",
]);
const receiptSchema = z.strictObject({
	requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
	provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	action: actionSchema,
	target: z.string().min(1).max(512),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	state: z.enum(["attempting", "completed", "failed"]),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.string().max(128).optional(),
});
const documentSchema = z.strictObject({
	version: z.literal(1),
	writes: z.record(z.string(), receiptSchema),
});
type Document = z.output<typeof documentSchema>;

const unavailable = () => new OperationRefusal("provider-write-unavailable");
const keyFor = (provider: string, requestId: string) =>
	createHash("sha256")
		.update(JSON.stringify([provider, requestId]))
		.digest("hex");

export type ProviderWriteClaim = {
	requestId: string;
	provider: string;
	action: ProviderWriteAction;
	target: string;
	digest: string;
};

export function openProviderWriteJournal(directory: string) {
	const root = fs.realpathSync(directory);
	const file = path.join(root, "provider-writes.json");
	const temp = () => path.join(root, `.provider-writes-${randomUUID()}.tmp`);
	const readFile = (): Document => {
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, writes: {} };
			throw unavailable();
		}
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > byteLimit
		)
			throw unavailable();
		const fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const opened = fs.fstatSync(fd);
			if (
				!opened.isFile() ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				(opened.mode & 0o077) !== 0
			)
				throw unavailable();
			const bytes = Buffer.alloc(byteLimit + 1);
			let length = 0;
			while (length < bytes.length) {
				const size = fs.readSync(
					fd,
					bytes,
					length,
					bytes.length - length,
					null,
				);
				if (!size) break;
				length += size;
			}
			if (length > byteLimit) throw unavailable();
			try {
				return documentSchema.parse(
					JSON.parse(bytes.subarray(0, length).toString("utf8")),
				);
			} catch {
				throw unavailable();
			}
		} finally {
			fs.closeSync(fd);
		}
	};
	const save = (document: Document) => {
		const value = `${JSON.stringify(document)}\n`;
		if (Buffer.byteLength(value) > byteLimit) throw unavailable();
		const target = temp();
		const fd = fs.openSync(target, "wx", 0o600);
		try {
			fs.writeFileSync(fd, value);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.renameSync(target, file);
		} catch {
			try {
				fs.rmSync(target, { force: true });
			} catch {
				/* Best effort. */
			}
			throw unavailable();
		}
	};
	const document = readFile();
	let interrupted = false;
	for (const receipt of Object.values(document.writes))
		if (receipt.state === "attempting") {
			receipt.state = "failed";
			receipt.error = "provider-write-interrupted";
			receipt.updatedAt = Date.now();
			interrupted = true;
		}
	if (interrupted) save(document);
	const prune = () => {
		const entries = Object.entries(document.writes);
		if (entries.length <= writeLimit) return;
		const removable = entries
			.filter(([, receipt]) => receipt.state !== "attempting")
			.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
		for (const [key] of removable) {
			if (Object.keys(document.writes).length <= writeLimit) break;
			delete document.writes[key];
		}
		if (Object.keys(document.writes).length > writeLimit)
			throw new OperationRefusal("journal-capacity");
	};
	return {
		claim(input: ProviderWriteClaim) {
			const key = keyFor(input.provider, input.requestId);
			const existing = document.writes[key];
			if (existing) {
				if (existing.digest !== input.digest)
					throw new OperationRefusal("request-conflict");
				if (existing.state === "attempting")
					throw new OperationRefusal("provider-write-in-progress");
				return { replay: true as const, key, receipt: existing };
			}
			const now = Date.now();
			const receipt: ProviderWriteReceipt = {
				requestId: input.requestId,
				provider: input.provider,
				action: input.action,
				target: input.target,
				digest: input.digest,
				state: "attempting",
				createdAt: now,
				updatedAt: now,
			};
			document.writes[key] = receipt;
			try {
				prune();
				save(document);
			} catch (error) {
				delete document.writes[key];
				throw error;
			}
			return { replay: false as const, key, receipt };
		},
		complete(
			key: string,
			outcome: { result: Record<string, unknown> } | { error: string },
		) {
			const receipt = document.writes[key];
			if (!receipt) throw unavailable();
			receipt.state = "result" in outcome ? "completed" : "failed";
			receipt.updatedAt = Date.now();
			if ("result" in outcome) {
				receipt.result = outcome.result;
				delete receipt.error;
			} else {
				receipt.error = outcome.error;
				delete receipt.result;
			}
			save(document);
			return receipt;
		},
		list(provider?: string) {
			return Object.values(document.writes)
				.filter((receipt) => !provider || receipt.provider === provider)
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.slice(0, 50);
		},
	};
}
