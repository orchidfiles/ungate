import { randomUUID } from 'node:crypto';

export interface CursorCapabilityReport {
	apiAvailable: boolean;
	credentialsReadable: boolean;
	sessionTokenAvailable: boolean;
	headerHelperWorks: boolean;
	refreshAvailable: boolean;
	failed: boolean;
}

/** Local-only inspection. Never returns credentials, headers, identity, URLs, or exception text. */
export function inspectCursorCapabilities(candidate: unknown): CursorCapabilityReport {
	const report: CursorCapabilityReport = {
		apiAvailable: false,
		credentialsReadable: false,
		sessionTokenAvailable: false,
		headerHelperWorks: false,
		refreshAvailable: false,
		failed: false
	};

	try {
		if (typeof candidate !== 'object' || candidate === null) return report;
		const api = candidate as Record<string, unknown>;
		report.apiAvailable = true;
		report.refreshAvailable = typeof api.triggerRefreshCursorAuthToken === 'function';
		if (typeof api.getCursorCreds === 'function') {
			const credentials: unknown = (api.getCursorCreds as () => unknown).call(api);
			report.credentialsReadable = typeof credentials === 'object' && credentials !== null;
		}
		if (typeof api.getCursorAuthToken === 'function') {
			const token: unknown = (api.getCursorAuthToken as () => unknown).call(api);
			report.sessionTokenAvailable = typeof token === 'string' && token.length > 0;
		}
		if (typeof api.getAllRequestHeadersExceptAccessToken === 'function') {
			const header = new Headers();
			(api.getAllRequestHeadersExceptAccessToken as (input: { req: { header: Headers }; backupRequestId: string }) => void).call(
				api,
				{ req: { header }, backupRequestId: randomUUID() }
			);
			report.headerHelperWorks = header.has('x-cursor-checksum') && header.has('x-cursor-client-version');
		}
	} catch {
		report.failed = true;
	}

	return report;
}
