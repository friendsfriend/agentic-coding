import { createSignal } from "solid-js";

export type SessionGitRequest = {
	directory: string;
	nonce: number;
};

const [request, setRequest] = createSignal<SessionGitRequest>();
let nonce = 0;

export function requestSessionGit(directory: string) {
	nonce += 1;
	setRequest({ directory, nonce });
}

export function takeSessionGitRequest() {
	const current = request();
	if (current) setRequest(undefined);
	return current;
}

export type SessionProviderRequest = {
	directory: string;
	kind: "issues" | "changes";
	nonce: number;
};

const [providerRequest, setProviderRequest] =
	createSignal<SessionProviderRequest>();

export function requestSessionProvider(
	directory: string,
	kind: "issues" | "changes",
) {
	nonce += 1;
	setProviderRequest({ directory, kind, nonce });
}

export function takeSessionProviderRequest() {
	const current = providerRequest();
	if (current) setProviderRequest(undefined);
	return current;
}
