import { parseBoardSnapshot } from './board-snapshot';

export function parseImportedBoard(serialized: string) {
  return parseBoardSnapshot(serialized);
}

export function downloadJson(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
