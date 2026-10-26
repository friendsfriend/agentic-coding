// One entry point for the shared UI framework inside the environment package.
//
// The environment surface renders `@agentic-coding/ui` directly; this barrel exists so the
// framework has a *second* module path to be imported through, which is what
// `test/dash/devenvUiPrimitives.test.ts` compares against the dashboard's
// imports: a reintroduced local copy of a primitive fails that identity check.
export * from "@agentic-coding/ui";
