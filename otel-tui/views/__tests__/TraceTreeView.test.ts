import { describe, expect, it } from 'bun:test';
import { treeWindow } from '../TraceTreeView';

describe('treeWindow', () => {
  it('keeps selection visible while rendering one viewport', () => {
    expect(treeWindow(1_000, 500, 20)).toEqual({ start: 490, end: 510 });
    expect(treeWindow(1_000, 0, 20)).toEqual({ start: 0, end: 20 });
    expect(treeWindow(1_000, 999, 20)).toEqual({ start: 980, end: 1_000 });
    expect(treeWindow(0, 0, 20)).toEqual({ start: 0, end: 0 });
  });
});
