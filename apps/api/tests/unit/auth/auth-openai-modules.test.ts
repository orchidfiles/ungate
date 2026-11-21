import { describe, expect, it } from 'vitest';

import { OpenAIOAuthUtils } from 'src/auth/openai/openai-oauth-utils';

describe('auth-openai-modules', () => {
	it('returns nulls for malformed id token', () => {
		expect(OpenAIOAuthUtils.parseIdToken('bad-token')).toEqual({
			email: null,
			authInfo: null,
			userId: null
		});
	});

	it('extracts the user identity from the id token subject', () => {
		const payload = Buffer.from(JSON.stringify({ sub: 'user-1', email: 'u@example.com' })).toString('base64url');
		expect(OpenAIOAuthUtils.parseIdToken(`h.${payload}.s`)).toMatchObject({ userId: 'user-1', email: 'u@example.com' });
	});

	it('escapes error text in the callback page', () => {
		const page = OpenAIOAuthUtils.callbackPage(false, '<script>alert(1)</script>');
		expect(page).not.toContain('<script>');
		expect(page).toContain('&#60;script&#62;');
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
