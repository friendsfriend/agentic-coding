export function isDiffFileAddedOrDeleted(diff: string): boolean {
	for (const line of diff.split("\n")) {
		if (
			line === "--- /dev/null" ||
			line.startsWith("--- /dev/null\t") ||
			line.startsWith("--- /dev/null ")
		)
			return true;
		if (
			line === "+++ /dev/null" ||
			line.startsWith("+++ /dev/null\t") ||
			line.startsWith("+++ /dev/null ")
		)
			return true;
		if (
			line.startsWith("new file mode ") ||
			line.startsWith("deleted file mode ")
		)
			return true;
	}

	return false;
}
