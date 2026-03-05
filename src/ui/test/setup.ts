import '@testing-library/jest-dom/vitest';

type StorageMap = Map<string, string>;

function createStorageMock(seed?: StorageMap): Storage {
  const map = seed ?? new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    }
  };
}

const globalRecord = globalThis as Record<string, unknown>;
const existing = globalRecord.localStorage;
if (
  !existing
  || typeof existing !== 'object'
  || typeof (existing as Partial<Storage>).getItem !== 'function'
  || typeof (existing as Partial<Storage>).setItem !== 'function'
  || typeof (existing as Partial<Storage>).clear !== 'function'
) {
  globalRecord.localStorage = createStorageMock();
}
