/** Retained signatures only; decoding/rendering remains independently bounded. */
export function imageMediaType(bytes: Uint8Array): string | null {
	const prefix = Buffer.from(bytes.subarray(0, 16));
	if (
		prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return "image/png";
	if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
		return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString("ascii")))
		return "image/gif";
	if (
		prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
		prefix.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	return null;
}
export function evidenceMediaType(bytes: Buffer, kind: string): string {
	if (kind === "image") {
		const type = imageMediaType(bytes);
		if (type) return type;
	}
	if (
		kind === "trace" &&
		bytes[0] === 80 &&
		bytes[1] === 75 &&
		((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
	)
		return "application/zip";
	if (kind === "video") {
		if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
			return "video/webm";
		if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp")
			return "video/mp4";
	}
	if (["log", "script", "report", "json"].includes(kind)) {
		const text = bytes.toString("utf8");
		if (!Buffer.from(text).equals(bytes) || text.includes("\0"))
			throw new Error("Evidence text must be valid UTF-8 without NUL");
		if (kind === "json") {
			try {
				JSON.parse(text);
			} catch {
				throw new Error("Evidence JSON source is invalid");
			}
			return "application/json";
		}
		return kind === "report" ? "text/markdown" : "text/plain";
	}
	throw new Error("Declared evidence kind does not match its retained bytes");
}
export function validateEvidenceType(
	bytes: Buffer,
	mediaType: string,
): boolean {
	if (mediaType.startsWith("image/"))
		return imageMediaType(bytes) === mediaType;
	const kind =
		mediaType === "application/zip"
			? "trace"
			: mediaType.startsWith("video/")
				? "video"
				: mediaType === "text/markdown"
					? "report"
					: mediaType === "application/json"
						? "json"
						: "log";
	try {
		return evidenceMediaType(bytes, kind) === mediaType;
	} catch {
		return false;
	}
}
