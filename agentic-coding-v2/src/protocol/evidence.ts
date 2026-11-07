export const evidenceMediaTypes = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"text/plain",
	"text/markdown",
	"application/json",
	"application/zip",
	"video/webm",
	"video/mp4",
] as const;
export type EvidenceDocument = {
	id: string;
	taskId: number;
	mediaType: string;
	caption: string;
	content: string;
	offset: number;
	totalBytes: number;
	nextOffset: number | null;
};
