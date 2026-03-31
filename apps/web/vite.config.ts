import { fileURLToPath, URL } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), svelte(), Icons({ compiler: 'svelte', autoInstall: false })],
	resolve: {
		alias: {
			$shared: fileURLToPath(new URL('./src/shared', import.meta.url)),
			$components: fileURLToPath(new URL('./src/components', import.meta.url)),
			$features: fileURLToPath(new URL('./src/features', import.meta.url)),
			$layouts: fileURLToPath(new URL('./src/layouts', import.meta.url)),
			$src: fileURLToPath(new URL('./src', import.meta.url))
		}
	}
});
