export type FetchFunction = typeof fetch;

export interface ClientDeps {
	baseUrl: string;
	fetchFn: FetchFunction;
	sseFetchFn: FetchFunction;
	onError?: (title: string, message: string) => void;
}
