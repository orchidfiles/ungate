import { describe, expect, it, vi } from 'vitest';

import { inspectCursorCapabilities } from '../../src/cursor-capability-diagnostic';

describe('local Cursor capability diagnostic', () => {
	it('reports unsupported hosts without throwing', () => {
		expect(inspectCursorCapabilities(undefined)).toEqual({
			apiAvailable: false,
			credentialsReadable: false,
			sessionTokenAvailable: false,
			headerHelperWorks: false,
			refreshAvailable: false,
			failed: false
		});
	});

	it('returns only booleans and never invokes refresh', () => {
		const refresh = vi.fn();
		const report = inspectCursorCapabilities({
			getCursorCreds: () => ({ backendUrl: 'secret-url', account: 'secret-account' }),
			getCursorAuthToken: () => 'secret-token',
			getAllRequestHeadersExceptAccessToken: ({ req }: { req: { header: Headers } }) => {
				req.header.set('x-cursor-checksum', 'secret-checksum');
				req.header.set('x-cursor-client-version', 'test');
			},
			triggerRefreshCursorAuthToken: refresh
		});
		expect(report).toEqual({
			apiAvailable: true,
			credentialsReadable: true,
			sessionTokenAvailable: true,
			headerHelperWorks: true,
			refreshAvailable: true,
			failed: false
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(JSON.stringify(report)).not.toContain('secret');
	});

	it('redacts thrown errors from restricted APIs', () => {
		const report = inspectCursorCapabilities({
			getCursorCreds: () => {
				throw new Error('secret-token');
			}
		});
		expect(report.failed).toBe(true);
		expect(JSON.stringify(report)).not.toContain('secret-token');
	});

	it('does not treat missing headers or non-string tokens as success', () => {
		const report = inspectCursorCapabilities({
			getCursorCreds: () => undefined,
			getCursorAuthToken: () => ({ token: 'secret' }),
			getAllRequestHeadersExceptAccessToken: () => undefined
		});
		expect(report.credentialsReadable).toBe(false);
		expect(report.sessionTokenAvailable).toBe(false);
		expect(report.headerHelperWorks).toBe(false);
	});
});
