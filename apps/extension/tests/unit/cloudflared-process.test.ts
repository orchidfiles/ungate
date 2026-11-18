import { describe, expect, it } from 'vitest';

import { CloudflaredProcess } from '../../src/runtime-state/cloudflared-process';

describe('CloudflaredProcess', () => {
	it('matches cloudflared pointed at the IPv4 origin', () => {
		const command = 'cloudflared tunnel --url http://127.0.0.1:47821 --config /dev/null';

		expect(CloudflaredProcess.servesApiPort(command, 47821)).toBe(true);
		expect(CloudflaredProcess.servesApiPort(command, 47822)).toBe(false);
	});

	it('matches any IPv4 origin when the api port has been cleared', () => {
		expect(CloudflaredProcess.servesApiPort('cloudflared tunnel --url http://127.0.0.1:47821', null)).toBe(true);
	});

	it('ignores a tunnel still aimed at localhost', () => {
		expect(CloudflaredProcess.servesApiPort('cloudflared tunnel --url http://localhost:47821', 47821)).toBe(false);
	});
});
