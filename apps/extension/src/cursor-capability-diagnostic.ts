import { randomUUID } from 'node:crypto';

type Step = 'credentials' | 'sessionToken' | 'headerHelper' | 'spaceXMode';

export interface CursorCapabilityReport {
	apiAvailable: boolean;
	credentialsReadable: boolean;
	sessionTokenAvailable: boolean;
	/** `typeof` the token getter's result, so an empty token can be told apart from a missing one. */
	sessionTokenType: string | null;
	headerHelperWorks: boolean;
	refreshAvailable: boolean;
	/**
	 * Cursor 3.27+ deployment-profile mode. Cursor withholds the session token from extensions
	 * unless this is `off` or `active`; `null` means this Cursor build has no such mode.
	 */
	spaceXMode: string | null;
	/** Steps that threw, with the error class name only (never the message). */
	failedSteps: Partial<Record<Step, string>>;
	failed: boolean;
}

/** Local-only inspection. Never returns credentials, headers, identity, URLs, or exception text. */
export function inspectCursorCapabilities(candidate: unknown): CursorCapabilityReport {
	const report: CursorCapabilityReport = {
		apiAvailable: false,
		credentialsReadable: false,
		sessionTokenAvailable: false,
		sessionTokenType: null,
		headerHelperWorks: false,
		refreshAvailable: false,
		spaceXMode: null,
		failedSteps: {},
		failed: false
	};

	if (typeof candidate !== 'object' || candidate === null) return report;
	const api = candidate as Record<string, unknown>;
	report.apiAvailable = true;
	report.refreshAvailable = typeof api.triggerRefreshCursorAuthToken === 'function';

	const step = (name: Step, run: () => void) => {
		try {
			run();
		} catch (error) {
			report.failedSteps[name] = error instanceof Error ? error.constructor.name : typeof error;
			report.failed = true;
		}
	};

	step('credentials', () => {
		if (typeof api.getCursorCreds !== 'function') return;
		const credentials: unknown = (api.getCursorCreds as () => unknown).call(api);
		report.credentialsReadable = typeof credentials === 'object' && credentials !== null;
	});

	step('sessionToken', () => {
		if (typeof api.getCursorAuthToken !== 'function') return;
		const token: unknown = (api.getCursorAuthToken as () => unknown).call(api);
		report.sessionTokenType = typeof token;
		report.sessionTokenAvailable = typeof token === 'string' && token.length > 0;
	});

	step('headerHelper', () => {
		if (typeof api.getAllRequestHeadersExceptAccessToken !== 'function') return;
		const header = new Headers();
		(api.getAllRequestHeadersExceptAccessToken as (input: { req: { header: Headers }; backupRequestId: string }) => void).call(
			api,
			{
				req: { header },
				backupRequestId: randomUUID()
			}
		);
		report.headerHelperWorks = header.has('x-cursor-checksum') && header.has('x-cursor-client-version');
	});

	step('spaceXMode', () => {
		if (typeof api.getSpaceXMode !== 'function') return;
		const mode: unknown = (api.getSpaceXMode as () => unknown).call(api);
		report.spaceXMode = typeof mode === 'string' ? mode : typeof mode;
	});

	return report;
}
