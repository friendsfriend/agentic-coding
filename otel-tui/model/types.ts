export interface MetricData {
  resource: { attributes: Array<{ key: string; value: string }> };
  scope: { name: string; version: string };
  name: string;
  description: string;
  unit: string;
  type: 'gauge' | 'sum' | 'histogram';
  dataPoints: MetricDataPoint[];
  serviceName: string;
}

export interface MetricDataPoint {
  startTimeUnixNano: string;
  timeUnixNano: string;
  value: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
  attributes: Array<{ key: string; value: string }>;
}

export interface LogData {
  resource: { attributes: Array<{ key: string; value: string }> };
  scope: { name: string; version: string };
  timeUnixNano: string;
  severity: string;
  body: string;
  attributes: Array<{ key: string; value: string }>;
  traceId?: string;
  spanId?: string;
  serviceName: string;
}

export interface ServiceNode {
  id: string;
  parentIds: string[];
  childIds: string[];
  spanCount: number;
  errorCount: number;
  avgDurationMs: number;
}

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
