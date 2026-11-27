import { describe, expect, it, vi } from 'vitest';

import { inspectCursorCapabilities } from '../../src/cursor-capability-diagnostic';

describe('local Cursor capability diagnostic', () => {
	it('reports unsupported hosts without throwing', () => {
		expect(inspectCursorCapabilities(undefined)).toEqual({
			apiAvailable: false,
			credentialsReadable: false,
			sessionTokenAvailable: false,
			sessionTokenType: null,
			headerHelperWorks: false,
			refreshAvailable: false,
			spaceXMode: null,
			failedSteps: {},
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
			getSpaceXMode: () => 'off',
			triggerRefreshCursorAuthToken: refresh
		});
		expect(report).toEqual({
			apiAvailable: true,
			credentialsReadable: true,
			sessionTokenAvailable: true,
			sessionTokenType: 'string',
			headerHelperWorks: true,
			refreshAvailable: true,
			spaceXMode: 'off',
			failedSteps: {},
			failed: false
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(JSON.stringify(report)).not.toContain('secret');
	});

	it('names the failing step without leaking the error message, and keeps checking later steps', () => {
		const report = inspectCursorCapabilities({
			getCursorCreds: () => {
				throw new TypeError('secret-token');
			},
			getCursorAuthToken: () => 'tok',
			getSpaceXMode: () => 'signedOut'
		});
		expect(report.failed).toBe(true);
		expect(report.failedSteps).toEqual({ credentials: 'TypeError' });
		expect(report.sessionTokenAvailable).toBe(true);
		expect(report.spaceXMode).toBe('signedOut');
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
		expect(report.sessionTokenType).toBe('object');
		expect(report.headerHelperWorks).toBe(false);
		expect(JSON.stringify(report)).not.toContain('secret');
	});
});
