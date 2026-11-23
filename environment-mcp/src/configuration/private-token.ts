import fs from "node:fs";
import path from "node:path";

/** Read one private bearer token file. Symlinks, shared modes, foreign owners and
 * oversized values are refused rather than repaired. */
export function readPrivateTokenFile(file: string) {
	if (!path.isAbsolute(file)) throw new Error("Token file must be absolute");
	const stat = fs.lstatSync(file);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.() ||
		stat.size > 4096
	)
		throw new Error("Token file is not private");
	const token = fs.readFileSync(file, "utf8").trim();
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
		throw new Error("Invalid token file value");
	return token;
}
