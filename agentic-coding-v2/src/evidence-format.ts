/** Retained image signatures only; parsing/rendering remains independently bounded. */
export function imageMediaType(bytes: Uint8Array): string | null {
	const prefix = Buffer.from(bytes.subarray(0, 16));
	if (
		prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return "image/png";
	if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
		return "image/jpeg";
	if (
		prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
		prefix.subarray(0, 6).toString("ascii") === "GIF89a"
	)
		return "image/gif";
	if (
		prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
		prefix.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	return null;
}
