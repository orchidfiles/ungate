import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/main.ts'],
	outDir: 'bundle',
	format: 'cjs',
	target: 'node22',
	bundle: true,
	splitting: false,
	sourcemap: false,
	clean: true,
	outExtension: () => ({ js: '.cjs' }),
	noExternal: ['@fastify/cors', '@ungate/shared', 'date-fns', 'drizzle-orm', 'fastify'],
	external: ['better-sqlite3'],
});
