/**
 * Error handling utilities for the TUI
 * Provides standardized error handling and user-friendly error messages
 */

interface ErrorResponse {
	error: string;
	message: string;
	code: number;
}

/**
 * Parse an error response from the server
 */
function parseErrorResponse(response: Response, body: string): string {
	try {
		const json = JSON.parse(body) as ErrorResponse;
		if (json.message) {
			return json.message;
		}
	} catch {
		// Not JSON or doesn't have message field
	}

	// Fallback to status text or body
	if (body && body.length < 200) {
		return body;
	}

	return response.statusText || "Unknown error";
}

/**
 * Handle fetch errors specifically
 */
export async function handleFetchError(
	response: Response,
	onError?: (title: string, message: string) => void,
): Promise<never> {
	let errorMessage: string;

	try {
		const body = await response.text();
		errorMessage = parseErrorResponse(response, body);
	} catch {
		errorMessage = response.statusText || "Network error";
	}

	const title = `HTTP ${response.status} Error`;

	if (onError) {
		onError(title, errorMessage);
	}

	throw new Error(`${title}: ${errorMessage}`);
}
