import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real ffmpeg renders; generous but bounded.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
