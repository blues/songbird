import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lambda/**/*.test.ts', 'lib/**/*.test.ts'],
    setupFiles: ['./test-setup.ts'],
  },
});
