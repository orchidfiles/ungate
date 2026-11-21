import { readFileSync } from 'node:fs';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { adoptLegacyOAuthRows, getSqlite } from 'src/database/index';
import { OAuthAccounts } from 'src/database/oauth-accounts';

const add = (user: string, workspace = 'workspace') =>
	OAuthAccounts.saveLogin(
		'openai',
		{ accessToken: `secret-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 60_000 },
		{ providerUserId: user, providerAccountId: workspace, email: `${user}@example.com` },
		OAuthAccounts.list('openai')
	);

describe('OAuth account repository', () => {
	it('preserves separate users in one workspace and selects only the first account', () => {
		const a = add('a');
		const b = add('b');
		expect(OAuthAccounts.list('openai')).toHaveLength(2);
		expect(OAuthAccounts.active('openai')?.id).toBe(a.id);
		expect(add('a').id).toBe(a.id);
		expect(OAuthAccounts.list('openai')).toHaveLength(2);
		expect(b.id).not.toBe(a.id);
		expect(JSON.stringify(OAuthAccounts.view('openai'))).not.toMatch(/secret-|refresh-|accessToken|credentialVersion/);
	});
	it('rejects stale fallback after manual selection and skips unavailable accounts', () => {
		const a = add('a');
		const b = add('b');
		const c = add('c');
		const before = OAuthAccounts.policy('openai');
		OAuthAccounts.select('openai', b.id);
		expect(OAuthAccounts.compareAndSelect('openai', before.revision, a.id, c.id, 'limited')).toBe(false);
		OAuthAccounts.markCooldown(b.id, Date.now() + 1000, 'usage_limit', true, b.credentialVersion);
		OAuthAccounts.markNeedsLogin(c.id, c.credentialVersion);
		expect(OAuthAccounts.eligible('openai').map((row) => row.id)).toEqual([a.id]);
		expect(OAuthAccounts.eligible('openai', Date.now() + 2000).map((row) => row.id)).toContain(b.id);
		OAuthAccounts.remove('openai', b.id);
		expect(OAuthAccounts.active('openai')?.id).toBe(a.id);
	});
	it('rejects stale credential writes and never recreates an account deleted during login', () => {
		const a = add('a');
		add('a');
		expect(OAuthAccounts.updateCredentials(a.id, a.credentialVersion, { accessToken: 'stale' })).toBeUndefined();
		const latest = OAuthAccounts.list('openai');
		OAuthAccounts.remove('openai', a.id);
		expect(() =>
			OAuthAccounts.saveLogin('openai', { accessToken: 'late' }, { providerUserId: 'a', providerAccountId: 'workspace' }, latest)
		).toThrow(/removed/);
		expect(() =>
			OAuthAccounts.saveLogin(
				'openai',
				{ accessToken: 'late' },
				{ providerUserId: 'a', providerAccountId: 'workspace' },
				latest,
				a.id
			)
		).toThrow(/removed/);
		expect(OAuthAccounts.list('openai')).toHaveLength(0);
	});

	it('lets a fresh login win over a refresh that happened during the login window', () => {
		const a = add('a');
		const snapshot = OAuthAccounts.list('openai');
		const refreshed = OAuthAccounts.updateCredentials(a.id, a.credentialVersion, {
			accessToken: 'refreshed',
			refreshToken: 'r2',
			expiresAt: 1
		})!;
		const saved = OAuthAccounts.saveLogin(
			'openai',
			{ accessToken: 'login', refreshToken: 'r3', expiresAt: 2 },
			{ providerUserId: 'a', providerAccountId: 'workspace' },
			snapshot
		);
		expect(saved.id).toBe(a.id);
		expect(saved.accessToken).toBe('login');
		expect(saved.credentialVersion).toBe(refreshed.credentialVersion + 1);
		// The refresh generation is now stale and cannot overwrite the login.
		expect(OAuthAccounts.updateCredentials(a.id, refreshed.credentialVersion, { accessToken: 'late-refresh' })).toBeUndefined();
	});

	it('treats different workspaces of one user as separate accounts and enforces reconnect identity', () => {
		const personal = add('u', 'personal');
		const team = add('u', 'team');
		expect(team.id).not.toBe(personal.id);
		expect(() =>
			OAuthAccounts.saveLogin(
				'openai',
				{ accessToken: 'x' },
				{ providerUserId: 'other', providerAccountId: 'personal' },
				OAuthAccounts.list('openai'),
				personal.id
			)
		).toThrow(/does not match/);
		// Reconnecting one row with an identity already saved as another row is rejected rather than merged.
		expect(() =>
			OAuthAccounts.saveLogin(
				'openai',
				{ accessToken: 'x' },
				{ providerUserId: 'u', providerAccountId: 'team' },
				OAuthAccounts.list('openai'),
				personal.id
			)
		).toThrow(/does not match|already saved/);
		expect(OAuthAccounts.get(personal.id)?.accessToken).toBe('secret-u');
	});

	it('adopts identity-less legacy rows only on explicit reconnect and keeps saved label', () => {
		const legacy = OAuthAccounts.upsertActiveCredentials('claude', {
			accessToken: 'legacy-access',
			refreshToken: 'legacy-refresh',
			expiresAt: 1
		});
		expect(legacy.providerUserId).toBeNull();
		expect(OAuthAccounts.active('claude')?.id).toBe(legacy.id);
		OAuthAccounts.rename('claude', legacy.id, 'Work');
		const saved = OAuthAccounts.saveLogin(
			'claude',
			{ accessToken: 'new' },
			{ providerUserId: 'uuid', email: 'me@example.com' },
			OAuthAccounts.list('claude'),
			legacy.id
		);
		expect(saved.id).toBe(legacy.id);
		expect(saved.providerUserId).toBe('uuid');
		expect(saved.label).toBe('Work');
		expect(saved.needsLogin).toBe(false);
		// Without reconnect, an identity-less legacy row is not silently merged with a new identity.
		const other = OAuthAccounts.saveLogin(
			'claude',
			{ accessToken: 'b' },
			{ providerUserId: 'uuid-b' },
			OAuthAccounts.list('claude')
		);
		expect(other.id).not.toBe(legacy.id);
	});

	it('provides fallback selection, cooldown and CAS primitives', () => {
		const a = add('a');
		const b = add('b');
		const c = add('c');
		const now = Date.now();
		expect(OAuthAccounts.selection('openai')).toMatchObject({
			account: { id: a.id },
			policy: { activeAccountId: a.id, autoSwitch: true }
		});
		expect(OAuthAccounts.nextEligible('openai', a.id)?.id).toBe(b.id);
		expect(OAuthAccounts.nextEligible('openai', c.id)?.id).toBe(a.id);
		expect(OAuthAccounts.nextEligible('openai', a.id, [b.id])?.id).toBe(c.id);

		// Cooldown never shrinks, is ignored for a stale credential generation, and expires by time.
		expect(OAuthAccounts.markCooldown(b.id, now + 10_000, 'usage_limit', false, b.credentialVersion)).toBe(true);
		OAuthAccounts.markCooldown(b.id, now + 1_000, 'usage_limit', true);
		expect(OAuthAccounts.get(b.id)?.cooldownUntil).toBe(now + 10_000);
		expect(OAuthAccounts.markCooldown(c.id, now + 5_000, 'usage_limit', true, c.credentialVersion + 1)).toBe(false);
		expect(OAuthAccounts.earliestCooldownEnd('openai', now)).toBe(now + 10_000);
		expect(OAuthAccounts.nextEligible('openai', a.id)?.id).toBe(c.id);
		expect(OAuthAccounts.nextEligible('openai', a.id, [], now + 20_000)?.id).toBe(b.id);
		expect(OAuthAccounts.view('openai').accounts.find((row) => row.id === b.id)).toMatchObject({
			availability: 'cooling_down',
			cooldownEstimated: false
		});

		// Two requests that observed the same revision race: exactly one switch wins.
		const { policy } = OAuthAccounts.selection('openai');
		expect(OAuthAccounts.switchToNextEligible('openai', policy.revision, a.id, 'usage_limit')?.id).toBe(c.id);
		expect(OAuthAccounts.switchToNextEligible('openai', policy.revision, a.id, 'usage_limit')).toBeUndefined();
		expect(OAuthAccounts.selection('openai').policy).toMatchObject({
			activeAccountId: c.id,
			lastSwitchReason: 'usage_limit',
			revision: policy.revision + 1
		});

		// Auto-switch disabled blocks fallback switching but not manual selection.
		OAuthAccounts.setAutoSwitch('openai', false);
		const disabled = OAuthAccounts.selection('openai').policy;
		expect(OAuthAccounts.switchToNextEligible('openai', disabled.revision, c.id, 'usage_limit')).toBeUndefined();
		expect(OAuthAccounts.select('openai', a.id)).toBe(true);
		expect(OAuthAccounts.select('openai', b.id)).toBe(false);
		OAuthAccounts.clearCooldown(b.id);
		expect(OAuthAccounts.select('openai', b.id)).toBe(true);
	});

	it('selects the next account in saved order when the active one is removed, or none', () => {
		const a = add('a');
		const b = add('b');
		const c = add('c');
		OAuthAccounts.select('openai', b.id);
		OAuthAccounts.markNeedsLogin(c.id, c.credentialVersion);
		OAuthAccounts.remove('openai', b.id);
		expect(OAuthAccounts.active('openai')?.id).toBe(a.id);
		OAuthAccounts.remove('openai', a.id);
		expect(OAuthAccounts.policy('openai').activeAccountId).toBeNull();
		// A new login while nothing is active becomes active.
		const d = add('d');
		expect(OAuthAccounts.active('openai')?.id).toBe(d.id);
	});
	it('keeps the last account deleted when an older build left its legacy row behind', () => {
		const sqlite = getSqlite();
		const legacyRow = sqlite.prepare(
			'INSERT OR REPLACE INTO provider_settings (provider, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
		);
		legacyRow.run('claude', 'legacy-access', 'legacy-refresh', Date.now() + 60_000, 1);
		adoptLegacyOAuthRows(sqlite);
		const adopted = OAuthAccounts.active('claude');
		expect(adopted?.id).toBe('legacy-claude');

		OAuthAccounts.remove('claude', adopted!.id);
		// Restart: the older build's row is still there, and it may have refreshed since.
		adoptLegacyOAuthRows(sqlite);
		legacyRow.run('claude', 'legacy-access-2', 'legacy-refresh-2', Date.now() + 120_000, 1);
		adoptLegacyOAuthRows(sqlite);

		expect(OAuthAccounts.list('claude')).toHaveLength(0);
		expect(OAuthAccounts.active('claude')).toBeUndefined();
	});

	it('keeps the last account deleted even when it was not the active one', () => {
		const sqlite = getSqlite();
		sqlite
			.prepare('INSERT INTO provider_settings (provider, access_token, created_at) VALUES (?, ?, ?)')
			.run('openai', 'legacy-access', 1);
		const only = add('a');
		sqlite.prepare("UPDATE oauth_policies SET active_account_id = NULL WHERE provider = 'openai'").run();

		OAuthAccounts.remove('openai', only.id);
		adoptLegacyOAuthRows(sqlite);

		expect(OAuthAccounts.list('openai')).toHaveLength(0);
	});

	it('backfills legacy credentials idempotently and preserves MiniMax', () => {
		const db = new BetterSqlite3(':memory:');
		try {
			db.exec(
				'CREATE TABLE provider_settings (provider text PRIMARY KEY, access_token text, refresh_token text, expires_at integer, email text, account_id text, created_at integer, base_url text)'
			);
			const insert = db.prepare('INSERT INTO provider_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
			insert.run('claude', 'claude-access', 'claude-refresh', 1234, 'c@example.com', null, 12, null);
			insert.run('openai', 'openai-access', 'openai-refresh', 5678, 'o@example.com', 'workspace', 13, null);
			insert.run('minimax', 'api-key', null, null, null, null, 14, 'https://example.com');
			const migration = readFileSync(new URL('../../../drizzle/_0011.sql', import.meta.url), 'utf8');
			db.exec(migration);
			db.exec(migration);
			expect(db.prepare('SELECT provider FROM provider_settings').all()).toEqual([{ provider: 'minimax' }]);
			expect(
				db
					.prepare('SELECT access_token, refresh_token, expires_at, provider_account_id FROM oauth_accounts WHERE provider = ?')
					.get('openai')
			).toEqual({
				access_token: 'openai-access',
				refresh_token: 'openai-refresh',
				expires_at: 5678,
				provider_account_id: 'workspace'
			});
			expect(db.prepare('SELECT active_account_id FROM oauth_policies WHERE provider = ?').get('claude')).toEqual({
				active_account_id: 'legacy-claude'
			});

			// An older Ungate sharing the file later rewrites provider_settings with a newer token.
			insert.run('claude', 'claude-access-2', 'claude-refresh-2', 9999, null, null, 12, null);
			adoptLegacyOAuthRows(db);
			adoptLegacyOAuthRows(db);
			expect(
				db
					.prepare('SELECT access_token, refresh_token, expires_at, email, credential_version FROM oauth_accounts WHERE id = ?')
					.get('legacy-claude')
			).toEqual({
				access_token: 'claude-access-2',
				refresh_token: 'claude-refresh-2',
				expires_at: 9999,
				email: 'c@example.com',
				credential_version: 2
			});
			// The legacy row stays so the older build keeps working; MiniMax is untouched.
			expect(db.prepare('SELECT provider FROM provider_settings ORDER BY provider').all()).toEqual([
				{ provider: 'claude' },
				{ provider: 'minimax' }
			]);

			// A reconnected (verified) account and older tokens are never overwritten.
			db.prepare("UPDATE oauth_accounts SET provider_user_id = 'uuid' WHERE id = 'legacy-claude'").run();
			db.prepare(
				"UPDATE provider_settings SET access_token = 'claude-access-3', expires_at = 99999 WHERE provider = 'claude'"
			).run();
			insert.run('openai', 'openai-older', null, 1, null, null, 13, null);
			adoptLegacyOAuthRows(db);
			expect(db.prepare("SELECT access_token FROM oauth_accounts WHERE id = 'legacy-claude'").get()).toEqual({
				access_token: 'claude-access-2'
			});
			expect(db.prepare("SELECT access_token FROM oauth_accounts WHERE id = 'legacy-openai'").get()).toEqual({
				access_token: 'openai-access'
			});

			// With no saved account, the legacy row becomes the first, active account.
			db.exec(
				"DELETE FROM oauth_accounts WHERE provider = 'openai'; UPDATE oauth_policies SET active_account_id = NULL WHERE provider = 'openai'"
			);
			adoptLegacyOAuthRows(db);
			expect(db.prepare("SELECT active_account_id FROM oauth_policies WHERE provider = 'openai'").get()).toEqual({
				active_account_id: 'legacy-openai'
			});
		} finally {
			db.close();
		}
	});
});
