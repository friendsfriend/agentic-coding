// Wiki reads (establish-opencode-boundaries, task 5.6).
//
// Concept reads are checkout reads today: there is no server route for them
// yet, and the view consumes them synchronously inside memos, so these stay
// synchronous pass-throughs. What matters for the boundary is that a view never
// imports the wiki module itself; when a route lands, the cache-backed selectors
// in `git.ts` take over.
export {
	buildWikiTree,
	flattenWikiTree,
	listConcepts,
	readConcept,
	renderDocument,
	type WikiConcept,
	type WikiReviewComment,
	type WikiTreeNode,
} from "../../workflow/wiki.ts";
