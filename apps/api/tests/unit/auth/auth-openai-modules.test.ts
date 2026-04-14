import { describe, expect, it } from 'vitest';

import { OpenAIOAuthUtils } from 'src/auth/openai/openai-oauth-utils';

describe('auth-openai-modules', () => {
	it('returns nulls for malformed id token', () => {
		expect(OpenAIOAuthUtils.parseIdToken('bad-token')).toEqual({
			email: null,
			authInfo: null
		});
	});

	it('prefers team org id for free plan when available', () => {
		const workspaceId = OpenAIOAuthUtils.resolveWorkspace({
			chatgpt_account_id: 'personal',
			chatgpt_plan_type: 'free',
			chatgpt_user_id: 'u',
			user_id: 'u',
			organizations: [
				{
					id: 'org_team',
					is_default: false,
					role: 'member',
					title: 'Team Workspace'
				}
			]
		});

		expect(workspaceId).toBe('org_team');
	});
});
