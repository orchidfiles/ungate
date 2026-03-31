import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		dir: 'tests',
		include: ['**/*.spec.ts', '**/*.test.ts'],
		mockReset: true,
		testTimeout: 15_000,
		exclude: ['dist'],
		passWithNoTests: true
	}
});
