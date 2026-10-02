// Bun resolves `with { type: "file" }` imports to a path (an embedded
// `$bunfs` path in a compiled binary), which is what the codemode sandbox needs
// for its QuickJS wasm.
declare module "*.wasm" {
	const path: string;
	export default path;
}
