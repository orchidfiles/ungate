import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/extension.ts'],
	outDir: 'dist',
	format: 'cjs',
	target: 'node22',
	bundle: true,
	splitting: false,
	sourcemap: false,
	clean: true,
	noExternal: ['cloudflared'],
	external: ['vscode']
});
