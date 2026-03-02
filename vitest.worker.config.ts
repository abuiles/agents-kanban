import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig({
  resolve: {
    alias: {
      '@cloudflare/sandbox': path.resolve(root, 'tests/worker/sandbox-test-shim.ts')
    }
  },
  test: {
    include: ['tests/worker/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.vitest.jsonc'
        }
      }
    }
  }
});
