import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: process.env.VITEST
      ? [
          { find: '@cloudflare/sandbox/xterm', replacement: path.resolve(__dirname, 'tests/worker/sandbox-xterm-test-shim.ts') },
          { find: /^@cloudflare\/sandbox$/, replacement: path.resolve(__dirname, 'tests/worker/sandbox-test-shim.ts') },
          { find: 'cloudflare:workflows', replacement: path.resolve(__dirname, 'tests/cloudflare-workflows-test-shim.ts') }
        ]
      : undefined
  },
  plugins: process.env.VITEST ? [tailwindcss(), react()] : [tailwindcss(), cloudflare(), react()],
  test: {
    include: ['src/ui/**/*.test.ts', 'src/ui/**/*.test.tsx', 'src/server/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/ui/test/setup.ts']
  },
  server: {
    host: true,
    allowedHosts: [
      ".trycloudflare.com", // Allow all Cloudflare tunnel subdomains,
    ],
  },
});
