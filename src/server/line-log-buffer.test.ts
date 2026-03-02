import { describe, expect, it } from 'vitest';
import { LineLogBuffer } from './line-log-buffer';

describe('LineLogBuffer', () => {
  it('emits complete lines and keeps partial lines buffered', () => {
    const buffer = new LineLogBuffer();

    expect(buffer.push('first line\nsecond')).toEqual(['first line']);
    expect(buffer.push(' line\nthird line\n')).toEqual(['second line', 'third line']);
    expect(buffer.flush()).toEqual([]);
  });

  it('normalizes carriage returns and flushes trailing content', () => {
    const buffer = new LineLogBuffer();

    expect(buffer.push('alpha\r\nbeta\rgamma')).toEqual(['alpha', 'beta']);
    expect(buffer.flush()).toEqual(['gamma']);
  });
});
