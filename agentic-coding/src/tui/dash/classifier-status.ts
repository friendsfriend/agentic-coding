// Classifier provider + local-model status for the Settings surface
// (introduce-local-model-support-for-classification). Reads go through the
// typed backend client when a transport is configured and fall back to the
// in-process server module for a transport-less run (demo/tests), so the view
// component performs no I/O and never downloads anything itself. Every call
// keeps the last snapshot on failure rather than throwing: the modal is a
// progress surface, and an unreachable server must not look like a no-op.
import type { ClassifierStatusResponse } from "../../contracts/gateway.ts";
import {
	cancelLocalClassifierInstall,
	classifierStatus as inProcessClassifierStatus,
	installLocalClassifier,
} from "../../server/classifier.ts";
import { backendClient } from "../../server/client.ts";

/** Last status read; undefined before the first refresh. */
let cached: ClassifierStatusResponse | undefined;
/** Message from the most recent failed install/cancel/status call, or undefined
 * after a success. The view surfaces it so a failed action is never a no-op. */
let lastError: string | undefined;

/** The cached snapshot, or undefined before the first read. */
export function classifierSnapshot(): ClassifierStatusResponse | undefined {
	return cached;
}

/** The last failure message, consumed by the view's error toast. */
export function lastClassifierError(): string | undefined {
	return lastError;
}

/** Clear a consumed failure message. */
export function clearClassifierError(): void {
	lastError = undefined;
}

/** Drop the cached snapshot (tests, and a scope switch). */
export function clearClassifierSnapshot(): void {
	cached = undefined;
	lastError = undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/** Read the current provider selection and local-model state. */
export async function refreshClassifierStatus(
	repository?: string,
): Promise<ClassifierStatusResponse | undefined> {
	const client = backendClient();
	if (!client) {
		try {
			cached = await inProcessClassifierStatus(repository);
			lastError = undefined;
		} catch (error) {
			lastError = message(error);
		}
		return cached;
	}
	try {
		cached = await client.classifierStatus(repository);
		lastError = undefined;
	} catch (error) {
		// An unavailable server keeps the last snapshot rather than inventing one.
		lastError = message(error);
	}
	return cached;
}

/** Start (or resume) the local acquisition. Idempotent on the server. */
export async function startClassifierInstall(
	repository?: string,
): Promise<ClassifierStatusResponse | undefined> {
	const client = backendClient();
	if (!client) {
		try {
			cached = await installLocalClassifier(repository);
			lastError = undefined;
		} catch (error) {
			lastError = message(error);
		}
		return cached;
	}
	try {
		cached = await client.classifierInstall(repository);
		lastError = undefined;
	} catch (error) {
		lastError = message(error);
	}
	return cached;
}

/** Cancel an in-flight acquisition and clean its temp files. */
export async function cancelClassifierInstallJob(
	repository?: string,
): Promise<ClassifierStatusResponse | undefined> {
	const client = backendClient();
	if (!client) {
		try {
			cached = await cancelLocalClassifierInstall(repository);
			lastError = undefined;
		} catch (error) {
			lastError = message(error);
		}
		return cached;
	}
	try {
		cached = await client.classifierInstallCancel(repository);
		lastError = undefined;
	} catch (error) {
		lastError = message(error);
	}
	return cached;
}
