import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
