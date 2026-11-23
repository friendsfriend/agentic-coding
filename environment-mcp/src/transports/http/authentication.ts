import { timingSafeEqual } from "node:crypto";

export function matchesBearerCredential(request: Request, expected: string) {
	const credential =
		request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	return (
		credential.length === expected.length &&
		Buffer.byteLength(credential) === Buffer.byteLength(expected) &&
		timingSafeEqual(Buffer.from(credential), Buffer.from(expected))
	);
}
