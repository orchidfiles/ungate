import { sleep } from '@ungate/shared';
import { config } from 'src/config';

const SETUP_TIMEOUT_MS = 15_000;
const ONBOARD_POLL_MS = 2_000;
const ONBOARD_MAX_POLLS = 5;

export const UNSUPPORTED_CLIENT_MESSAGE =
	'Google rejected this Antigravity client for your account. Check your account eligibility in Antigravity. Reconnecting cannot override a Google access restriction.';

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
	cloudaicompanionProject?: string | { id?: string } | null;
}

interface OnboardOperation {
	done?: boolean;
	response?: { cloudaicompanionProject?: string | { id?: string } };
}

export type CodeAssistSetup =
	| { ok: true; projectId: string; tierId: string | null; tierName: string | null }
	| { ok: false; unsupported: boolean; error: string };

export class CodeAssistSetupClient {
	static async setup(accessToken: string): Promise<CodeAssistSetup> {
		const load = await this.post<LoadCodeAssistResponse>(accessToken, 'loadCodeAssist', {
			metadata: { ideType: 'ANTIGRAVITY' }
		});
		const ineligible = load.ineligibleTiers ?? [];
		const unsupported = ineligible.find((tier) => tier.reasonCode === 'UNSUPPORTED_CLIENT');
		if (unsupported) return this.ineligible(ineligible, unsupported);

		const tier = load.paidTier ?? load.currentTier;
		const projectId = this.projectId(load.cloudaicompanionProject);
		if (projectId) {
			return { ok: true, projectId, tierId: tier?.id ?? null, tierName: tier?.name ?? null };
		}
		if (ineligible.length) return this.ineligible(ineligible, unsupported);

		const onboardTier = (load.allowedTiers ?? []).find((candidate) => candidate.isDefault) ?? load.currentTier;
		const tierId = onboardTier?.id ?? 'free-tier';
		for (let poll = 0; poll < ONBOARD_MAX_POLLS; poll++) {
			if (poll) await sleep(ONBOARD_POLL_MS);
			const operation = await this.post<OnboardOperation>(accessToken, 'onboardUser', {
				tier_id: tierId,
				metadata: { ide_type: 'ANTIGRAVITY', ide_version: config.gemini.clientVersion, ide_name: 'antigravity' }
			});
			if (!operation.done) continue;
			const onboardedProject = this.projectId(operation.response?.cloudaicompanionProject);
			if (!onboardedProject) return this.ineligible([], undefined);

			return {
				ok: true,
				projectId: onboardedProject,
				tierId: tier?.id ?? tierId,
				tierName: tier?.name ?? onboardTier?.name ?? null
			};
		}

		return { ok: false, unsupported: false, error: 'Antigravity account onboarding timed out. Try signing in again.' };
	}

	private static projectId(value: string | { id?: string } | null | undefined): string | null {
		const id = typeof value === 'string' ? value : value?.id;

		return typeof id === 'string' && id.trim() ? id.trim() : null;
	}

	private static ineligible(tiers: IneligibleTier[], unsupported: IneligibleTier | undefined): CodeAssistSetup {
		if (unsupported) return { ok: false, unsupported: true, error: UNSUPPORTED_CLIENT_MESSAGE };
		const reasons = tiers.map((tier) => tier.reasonMessage).filter(Boolean);

		return {
			ok: false,
			unsupported: false,
			error: reasons.length
				? `Antigravity is unavailable for this account: ${reasons.join('; ')}`
				: 'Antigravity did not assign a project to this account'
		};
	}

	private static async post<T>(accessToken: string, method: string, body: object): Promise<T> {
		const onboarding = method === 'onboardUser';
		const response = await fetch(`${config.gemini.codeAssistUrl}:${method}`, {
			method: 'POST',
			body: JSON.stringify(body),
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': config.gemini.userAgent + (onboarding ? ' google-api-nodejs-client/10.3.0' : ''),
				...(onboarding ? { 'X-Goog-Api-Client': 'gl-node/22.21.1' } : {})
			},
			signal: AbortSignal.timeout(SETUP_TIMEOUT_MS)
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`Antigravity account setup failed (HTTP ${response.status})`);
		}

		const result: unknown = await response.json();

		return result as T;
	}
}
