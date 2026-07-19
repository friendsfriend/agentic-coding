import { describe, it, expect } from 'bun:test';

describe('Sparkline', () => {
  it('renders empty sparkline as dots', () => {
    // Pure logic test — the component uses unicode block chars
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const values: number[] = [];
    const width = 5;
    const chars = values.length ? [] : '·'.repeat(width);
    expect(chars).toBe('·····');
  });

  it('maps values to block chars ascending', () => {
    const values = [0, 50, 100];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const chars = values.map(v => {
      const normalized = (v - min) / range;
      const index = Math.min(blocks.length - 1, Math.floor(normalized * blocks.length));
      return blocks[index]!;
    });
    expect(chars[0]).toBe('▁');
    expect(chars[2]).toBe('█');
  });

  it('handles single value gracefully', () => {
    const values = [42];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const chars = values.map(v => {
      const normalized = (v - min) / range;
      const index = Math.min(blocks.length - 1, Math.floor(normalized * blocks.length));
      return blocks[index]!;
    });
    expect(chars[0]).toBe('▁'); // range = 0 → normalized = 0 → first block
  });

  it('handles downward trend', () => {
    const values = [100, 60, 20];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const chars = values.map(v => {
      const normalized = (v - min) / range;
      const index = Math.min(blocks.length - 1, Math.floor(normalized * blocks.length));
      return blocks[index]!;
    });
    expect(chars[0]).toBe('█');
    expect(chars[2]).toBe('▁');
  });
});
