import { describe, expect, it } from 'vitest';

import { commandServesApiPort } from '../../src/runtime-state/cloudflared-process';

describe('commandServesApiPort', () => {
	it('matches cloudflared pointed at the IPv4 origin', () => {
		const command = 'cloudflared tunnel --url http://127.0.0.1:47821 --config /dev/null';

		expect(commandServesApiPort(command, 47821)).toBe(true);
		expect(commandServesApiPort(command, 47822)).toBe(false);
	});

	it('matches any IPv4 origin when the api port has been cleared', () => {
		expect(commandServesApiPort('cloudflared tunnel --url http://127.0.0.1:47821', null)).toBe(true);
	});

	it('ignores a tunnel still aimed at localhost', () => {
		expect(commandServesApiPort('cloudflared tunnel --url http://localhost:47821', 47821)).toBe(false);
	});
});
