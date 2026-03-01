import { describe, expect, it } from 'vitest';
import { createSeedSnapshot } from './seed-data';
import { parseImportedBoard } from './import-export';

describe('import/export', () => {
  it('parses a valid snapshot', () => {
    const snapshot = createSeedSnapshot();
    expect(parseImportedBoard(JSON.stringify(snapshot)).repos).toHaveLength(snapshot.repos.length);
  });

  it('rejects an invalid snapshot', () => {
    expect(() => parseImportedBoard(JSON.stringify({ version: 2 }))).toThrow('Invalid AgentBoard snapshot.');
  });
});
