import { existsSync } from 'node:fs';

import { bin, install, Tunnel } from 'cloudflared';

const port = process.argv[2] ?? process.env.PORT ?? '4783';

if (!existsSync(bin)) {
	console.log('[tunnel] installing cloudflared...');
	await install(bin);
	console.log('[tunnel] cloudflared installed');
}

const tunnel = Tunnel.quick(`http://localhost:${port}`, {
	'--config': '/dev/null',
	'--edge-ip-version': '4'
});

tunnel.once('url', (url: string) => {
	console.log(`[tunnel] URL: ${url}`);
});

tunnel.once('error', (error: Error) => {
	console.error(`[tunnel] error: ${error.message}`);
	process.exit(1);
});

tunnel.once('exit', (code: number | null) => {
	if (code !== 0) {
		console.error(`[tunnel] exited with code ${code}`);
		process.exit(code ?? 1);
	}
});
