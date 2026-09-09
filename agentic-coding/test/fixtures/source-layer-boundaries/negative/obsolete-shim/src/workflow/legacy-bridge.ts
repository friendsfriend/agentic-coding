// The obsolete migration-only bridge that the cutover removes. Any remaining
// import of it must be flagged by the obsolete-shim architecture check.
export function drain(): number {
	return 0;
}
