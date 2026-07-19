export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: Array<{ key: string; value: string | number | boolean }>;
  resource: { attributes: Array<{ key: string; value: string | number | boolean }>; droppedAttributesCount: number };
  scope: { name: string; version: string };
  serviceName: string;
  kind: number;
}

export interface TreeNode {
  span: SpanData;
  depth: number;
  expanded: boolean;
  children: TreeNode[];
}

export interface TraceSummary {
  traceId: string;
  rootSpans: SpanData[];
  startTime: bigint;
  endTime: bigint;
  durationMs: number;
  errorCount: number;
  spanCount: number;
  agents: string[];
}
