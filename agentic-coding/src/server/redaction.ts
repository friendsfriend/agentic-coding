// The one floor two very different mechanisms share.
//
// `environment/agent-routes.ts` masks a *known* secret wherever it appears, from
// this length up; `stages/identity-cache.ts` refuses to *keep* a captured value
// below it. The two have to be the same number, or the cache stores values the
// scrubber cannot find and "every cached value is a secret" becomes false
// silently. Living in its own module is what keeps them one number: neither
// module has to import the other (the identity cache cannot import the agent
// routes without dragging the whole environment surface into the browser layer).

/** Declared and captured secrets at least this long are replaced wherever they
 * appear. Also the shortest value the identity cache keeps, and the shortest
 * value the browser scrubber can mask on its own. */
export const MIN_SECRET_CHARS = 6;
