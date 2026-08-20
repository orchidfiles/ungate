import { describe, expect, it } from 'vitest';

import { isAllowedDashboardOrigin } from 'src/plugins/cors-origin';

describe('cors-origin', () => {
	it('allows requests that carry no Origin header', () => {
		// Cursor's backend and CLI clients reach the proxy without an Origin; CORS is not involved.
		expect(isAllowedDashboardOrigin(undefined)).toBe(true);
		expect(isAllowedDashboardOrigin('')).toBe(true);
	});

	it('allows the VS Code and Cursor webview origins', () => {
		expect(isAllowedDashboardOrigin('vscode-webview://1a2b3c4d-5e6f-7788-99aa-bbccddeeff00')).toBe(true);
		expect(isAllowedDashboardOrigin('vscode-file://vscode-app')).toBe(true);
	});

	it('allows loopback origins for local web development', () => {
		expect(isAllowedDashboardOrigin('http://localhost:5173')).toBe(true);
		expect(isAllowedDashboardOrigin('http://127.0.0.1:4783')).toBe(true);
		expect(isAllowedDashboardOrigin('http://[::1]:5173')).toBe(true);
	});

	it('refuses arbitrary web origins', () => {
		expect(isAllowedDashboardOrigin('https://evil.example')).toBe(false);
		expect(isAllowedDashboardOrigin('http://attacker.test:8080')).toBe(false);
		expect(isAllowedDashboardOrigin('https://ungate.dev')).toBe(false);
	});

	it('refuses hostnames that merely embed a loopback name', () => {
		expect(isAllowedDashboardOrigin('https://localhost.evil.example')).toBe(false);
		expect(isAllowedDashboardOrigin('https://127.0.0.1.evil.example')).toBe(false);
		expect(isAllowedDashboardOrigin('https://notlocalhost')).toBe(false);
	});

	it('refuses opaque and unparseable origins', () => {
		expect(isAllowedDashboardOrigin('null')).toBe(false);
		expect(isAllowedDashboardOrigin('not an origin')).toBe(false);
		expect(isAllowedDashboardOrigin('file:///etc/passwd')).toBe(false);
	});

	it('refuses a tunnel hostname, which is where remote traffic arrives', () => {
		expect(isAllowedDashboardOrigin('https://random-words-1234.trycloudflare.com')).toBe(false);
	});
});
