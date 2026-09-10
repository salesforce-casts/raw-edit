import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real ffmpeg, real transcription, real object storage.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // The pipeline test drives one video through shared services; running its files
    // in parallel would have them fight over the same rows.
    fileParallelism: false,
  },
});
