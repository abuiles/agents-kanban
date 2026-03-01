import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: process.env.VITEST ? [tailwindcss(), react()] : [tailwindcss(), cloudflare(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/ui/test/setup.ts']
  }
});
