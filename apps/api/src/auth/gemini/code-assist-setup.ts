import { sleep } from '@ungate/shared';
import { config } from 'src/config';

/** Same client metadata gemini-cli sends from `code_assist/setup.ts`. */
const CLIENT_METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } as const;
const SETUP_TIMEOUT_MS = 15_000;
const ONBOARD_POLL_MS = 5_000;
const ONBOARD_MAX_POLLS = 12;

export const UNSUPPORTED_CLIENT_MESSAGE =
	'Google no longer allows Gemini CLI sign-in for this account type (individual, AI Pro and Ultra accounts were moved off this path on 2026-06-18). Use a Google Workspace / Code Assist Standard account, or reconnect after Google restores access.';

interface GeminiTier {
	id?: string;
	name?: string;
	isDefault?: boolean;
}

interface IneligibleTier {
	reasonCode?: string;
	reasonMessage?: string;
}

export interface LoadCodeAssistResponse {
	currentTier?: GeminiTier | null;
	paidTier?: GeminiTier | null;
	allowedTiers?: GeminiTier[] | null;
	ineligibleTiers?: IneligibleTier[] | null;
	cloudaicompanionProject?: string | null;
}

interface OnboardOperation {
	name?: string;
	done?: boolean;
	response?: { cloudaicompanionProject?: { id?: string } };
}

export type CodeAssistSetup =
	| { ok: true; projectId: string; tierId: string | null; tierName: string | null }
	/** `unsupported` = Google rejected this client for the account (needs-login with a migration message). */
	| { ok: false; unsupported: boolean; error: string };

/** Code Assist project + tier discovery (`loadCodeAssist`, then `onboardUser` when no project exists). */
export class CodeAssistSetupClient {
	static async setup(accessToken: string): Promise<CodeAssistSetup> {
		const load = await this.post<LoadCodeAssistResponse>(accessToken, 'loadCodeAssist', { metadata: CLIENT_METADATA });
		const ineligible = load.ineligibleTiers ?? [];
		const unsupported = ineligible.find((tier) => tier.reasonCode === 'UNSUPPORTED_CLIENT');

		if (load.currentTier) {
			const tier = load.paidTier ?? load.currentTier;
			if (load.cloudaicompanionProject) {
				return { ok: true, projectId: load.cloudaicompanionProject, tierId: tier.id ?? null, tierName: tier.name ?? null };
			}

			return this.ineligible(ineligible, unsupported);
		}
		if (unsupported) return { ok: false, unsupported: true, error: UNSUPPORTED_CLIENT_MESSAGE };

		const tier = (load.allowedTiers ?? []).find((candidate) => candidate.isDefault);
		if (!tier?.id) return this.ineligible(ineligible, unsupported);
		// The free tier uses a Google-managed project; sending one fails with Precondition Failed.
		let operation = await this.post<OnboardOperation>(accessToken, 'onboardUser', { tierId: tier.id, metadata: CLIENT_METADATA });
		for (let poll = 0; !operation.done && operation.name && poll < ONBOARD_MAX_POLLS; poll++) {
			await sleep(ONBOARD_POLL_MS);
			operation = await this.get<OnboardOperation>(accessToken, operation.name);
		}
		const projectId = operation.response?.cloudaicompanionProject?.id;
		if (!projectId) return this.ineligible(ineligible, unsupported);

		return { ok: true, projectId, tierId: tier.id, tierName: tier.name ?? null };
	}

	private static ineligible(tiers: IneligibleTier[], unsupported: IneligibleTier | undefined): CodeAssistSetup {
		if (unsupported) return { ok: false, unsupported: true, error: UNSUPPORTED_CLIENT_MESSAGE };
		const reasons = tiers.map((tier) => tier.reasonMessage).filter(Boolean);

		return {
			ok: false,
			unsupported: false,
			error: reasons.length
				? `Gemini Code Assist is unavailable for this account: ${reasons.join('; ')}`
				: 'Gemini Code Assist did not assign a project to this account'
		};
	}

	private static async post<T>(accessToken: string, method: string, body: object): Promise<T> {
		return this.call<T>(accessToken, `${config.gemini.codeAssistUrl}:${method}`, {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	private static async get<T>(accessToken: string, operationName: string): Promise<T> {
		return this.call<T>(accessToken, `${config.gemini.codeAssistUrl}/${operationName}`, { method: 'GET' });
	}

	private static async call<T>(accessToken: string, url: string, init: RequestInit): Promise<T> {
		const response = await fetch(url, {
			...init,
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
			signal: AbortSignal.timeout(SETUP_TIMEOUT_MS)
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Gemini Code Assist setup failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
		}

		const body: unknown = await response.json();

		return body as T;
	}
}
