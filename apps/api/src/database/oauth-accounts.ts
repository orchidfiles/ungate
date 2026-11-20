import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import { AccountUsageStore } from '../usage/usage-store';

import { oauthAccounts, oauthPolicies } from './schema';

import { getDb } from './index';

import type { AccountListResponse, AccountPolicy, SubscriptionAccount, SubscriptionProvider } from '@ungate/shared';

export type OAuthAccountRow = typeof oauthAccounts.$inferSelect;
export interface AccountCredentials {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: number | null;
}
export interface AccountIdentity {
	providerUserId: string;
	providerAccountId?: string | null;
	email?: string | null;
}
export type LoginAccountSnapshot = OAuthAccountRow[];

/** Atomic read of the provider policy plus its active account, captured once per incoming request. */
export interface AccountSelection {
	policy: AccountPolicy;
	account: OAuthAccountRow | undefined;
}
/** All mutations are synchronous SQLite transactions; no transaction spans a network call. */
export class OAuthAccounts {
	static get(id: string, provider?: SubscriptionProvider): OAuthAccountRow | undefined {
		return getDb()
			.select()
			.from(oauthAccounts)
			.where(provider ? and(eq(oauthAccounts.id, id), eq(oauthAccounts.provider, provider)) : eq(oauthAccounts.id, id))
			.get();
	}

	static list(provider: SubscriptionProvider): OAuthAccountRow[] {
		return getDb()
			.select()
			.from(oauthAccounts)
			.where(eq(oauthAccounts.provider, provider))
			.orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id))
			.all();
	}

	static policy(provider: SubscriptionProvider): AccountPolicy {
		getDb().insert(oauthPolicies).values({ provider }).onConflictDoNothing().run();

		return getDb().select().from(oauthPolicies).where(eq(oauthPolicies.provider, provider)).get() as AccountPolicy;
	}

	static active(provider: SubscriptionProvider): OAuthAccountRow | undefined {
		const id = this.policy(provider).activeAccountId;

		return id ? this.get(id, provider) : undefined;
	}

	static isEligible(account: OAuthAccountRow, now = Date.now()): boolean {
		return !account.needsLogin && (account.cooldownUntil === null || account.cooldownUntil <= now);
	}

	static eligible(provider: SubscriptionProvider, now = Date.now()): OAuthAccountRow[] {
		return this.list(provider).filter((account) => this.isEligible(account, now));
	}

	static selection(provider: SubscriptionProvider): AccountSelection {
		return getDb().transaction(() => {
			const policy = this.policy(provider);

			return { policy, account: policy.activeAccountId ? this.get(policy.activeAccountId, provider) : undefined };
		});
	}

	/**
	 * Next eligible account after `afterId` in stable saved order (wrapping), skipping `exclude`.
	 * With no `afterId` (or an unknown one) the search starts at the first saved account.
	 */
	static nextEligible(
		provider: SubscriptionProvider,
		afterId: string | null,
		exclude: Iterable<string> = [],
		now = Date.now()
	): OAuthAccountRow | undefined {
		const skip = new Set(exclude);
		const rows = this.list(provider);
		const start = afterId ? rows.findIndex((row) => row.id === afterId) + 1 : 0;
		const ordered = [...rows.slice(start), ...rows.slice(0, start)];

		return ordered.find((row) => row.id !== afterId && !skip.has(row.id) && this.isEligible(row, now));
	}

	/** Earliest future cooldown end among non-needs-login accounts, or null when none are cooling down. */
	static earliestCooldownEnd(provider: SubscriptionProvider, now = Date.now()): number | null {
		const ends = this.list(provider)
			.filter((row) => !row.needsLogin && row.cooldownUntil !== null && row.cooldownUntil > now)
			.map((row) => row.cooldownUntil!);

		return ends.length ? Math.min(...ends) : null;
	}

	static dto(account: OAuthAccountRow, activeId: string | null, now = Date.now()): SubscriptionAccount {
		return {
			id: account.id,
			provider: account.provider as SubscriptionProvider,
			label: account.label,
			email: account.email,
			providerUserId: account.providerUserId,
			providerAccountId: account.providerAccountId,
			createdAt: account.createdAt,
			updatedAt: account.updatedAt,
			active: activeId === account.id,
			availability: account.needsLogin ? 'needs_login' : this.isEligible(account, now) ? 'available' : 'cooling_down',
			cooldownUntil: account.cooldownUntil,
			cooldownReason: account.cooldownReason,
			cooldownEstimated: account.cooldownEstimated,
			usage: AccountUsageStore.get(account.id) ?? null
		};
	}

	static view(provider: SubscriptionProvider): AccountListResponse {
		return getDb().transaction(() => {
			const policy = this.policy(provider);

			return { policy, accounts: this.list(provider).map((account) => this.dto(account, policy.activeAccountId)) };
		});
	}

	/**
	 * Manual selection increments revision even when selecting the same account.
	 * Only eligible accounts (not needs-login, not cooling down) can be selected.
	 */
	static select(provider: SubscriptionProvider, id: string, revision?: number, reason = 'manual'): boolean {
		return getDb().transaction(() => {
			const account = this.get(id, provider);
			if (!account || !this.isEligible(account)) return false;
			const policy = this.policy(provider);
			if (revision !== undefined && policy.revision !== revision) return false;

			return (
				getDb()
					.update(oauthPolicies)
					.set({ activeAccountId: id, revision: policy.revision + 1, lastSwitchReason: reason })
					.where(and(eq(oauthPolicies.provider, provider), eq(oauthPolicies.revision, policy.revision)))
					.run().changes === 1
			);
		});
	}

	/** Fallback must supply BOTH the request's selection revision and failed active ID. */
	static compareAndSelect(
		provider: SubscriptionProvider,
		expectedRevision: number,
		expectedActiveId: string | null,
		id: string,
		reason: string
	): boolean {
		return getDb().transaction(() => {
			const policy = this.policy(provider);
			if (!policy.autoSwitch || policy.revision !== expectedRevision || policy.activeAccountId !== expectedActiveId) return false;

			return this.select(provider, id, expectedRevision, reason);
		});
	}

	/**
	 * Atomic fallback step: if the policy still matches what the request observed (`expectedRevision`
	 * and `failedAccountId`) and auto-switch is on, select the next eligible account after the failed
	 * one in stable saved order, skipping `exclude` (accounts already tried by this request).
	 * Returns the newly active row, or undefined when the policy moved on, auto-switch is off, or no
	 * account is eligible. Callers should re-read `selection()` on undefined: another request may
	 * already have switched to a usable account.
	 */
	static switchToNextEligible(
		provider: SubscriptionProvider,
		expectedRevision: number,
		failedAccountId: string,
		reason: string,
		exclude: Iterable<string> = []
	): OAuthAccountRow | undefined {
		return getDb().transaction(() => {
			const next = this.nextEligible(provider, failedAccountId, exclude);
			if (!next) return undefined;

			return this.compareAndSelect(provider, expectedRevision, failedAccountId, next.id, reason) ? this.get(next.id) : undefined;
		});
	}

	static setAutoSwitch(provider: SubscriptionProvider, autoSwitch: boolean, revision?: number): boolean {
		return getDb().transaction(() => {
			const policy = this.policy(provider);
			if (revision !== undefined && policy.revision !== revision) return false;

			return (
				getDb()
					.update(oauthPolicies)
					.set({ autoSwitch, revision: policy.revision + 1 })
					.where(and(eq(oauthPolicies.provider, provider), eq(oauthPolicies.revision, policy.revision)))
					.run().changes === 1
			);
		});
	}

	static rename(provider: SubscriptionProvider, id: string, label: string): boolean {
		return (
			getDb()
				.update(oauthAccounts)
				.set({ label, updatedAt: Date.now() })
				.where(and(eq(oauthAccounts.id, id), eq(oauthAccounts.provider, provider)))
				.run().changes === 1
		);
	}

	static remove(provider: SubscriptionProvider, id: string): boolean {
		return getDb().transaction(() => {
			if (!this.get(id, provider)) return false;
			// Successor follows stable saved order after the removed account.
			const next = this.nextEligible(provider, id);
			getDb().delete(oauthAccounts).where(eq(oauthAccounts.id, id)).run();
			AccountUsageStore.delete(id);
			const policy = this.policy(provider);
			// Emptying the list is recorded too: legacy adoption reads it as "the user removed these".
			if (policy.activeAccountId === id || this.list(provider).length === 0) {
				getDb()
					.update(oauthPolicies)
					.set({ activeAccountId: next?.id ?? null, revision: policy.revision + 1, lastSwitchReason: 'removed' })
					.where(eq(oauthPolicies.provider, provider))
					.run();
			}

			return true;
		});
	}

	/**
	 * Extends (never shrinks) a cooldown. Reason/estimated are replaced only when this call extends
	 * the cooldown, so a shorter estimate cannot relabel a longer exact reset. With
	 * `credentialVersion`, a stale request (older credential generation) cannot cool down the account.
	 */
	static markCooldown(id: string, until: number, reason: string, estimated: boolean, credentialVersion?: number): boolean {
		const extends_ = sql`(${oauthAccounts.cooldownUntil} IS NULL OR ${oauthAccounts.cooldownUntil} < ${until})`;

		return (
			getDb()
				.update(oauthAccounts)
				.set({
					cooldownUntil: sql`max(coalesce(${oauthAccounts.cooldownUntil}, 0), ${until})`,
					cooldownReason: sql`CASE WHEN ${extends_} THEN ${reason} ELSE ${oauthAccounts.cooldownReason} END`,
					cooldownEstimated: sql`CASE WHEN ${extends_} THEN ${estimated ? 1 : 0} ELSE ${oauthAccounts.cooldownEstimated} END`,
					updatedAt: Date.now()
				})
				.where(
					and(
						eq(oauthAccounts.id, id),
						credentialVersion === undefined ? undefined : eq(oauthAccounts.credentialVersion, credentialVersion)
					)
				)
				.run().changes === 1
		);
	}

	/** Clears a cooldown early (e.g. a later successful request proved the account usable). */
	static clearCooldown(id: string): boolean {
		return (
			getDb()
				.update(oauthAccounts)
				.set({ cooldownUntil: null, cooldownReason: null, cooldownEstimated: false, updatedAt: Date.now() })
				.where(eq(oauthAccounts.id, id))
				.run().changes === 1
		);
	}

	static markNeedsLogin(id: string, credentialVersion: number): boolean {
		return (
			getDb()
				.update(oauthAccounts)
				.set({ needsLogin: true, updatedAt: Date.now() })
				.where(and(eq(oauthAccounts.id, id), eq(oauthAccounts.credentialVersion, credentialVersion)))
				.run().changes === 1
		);
	}

	static updateCredentials(id: string, expectedVersion: number, credentials: AccountCredentials): OAuthAccountRow | undefined {
		return getDb().transaction(() => {
			const { accessToken, refreshToken, expiresAt } = credentials;
			const changed = getDb()
				.update(oauthAccounts)
				.set({
					accessToken,
					refreshToken,
					expiresAt,
					credentialVersion: expectedVersion + 1,
					needsLogin: false,
					updatedAt: Date.now()
				})
				.where(and(eq(oauthAccounts.id, id), eq(oauthAccounts.credentialVersion, expectedVersion)))
				.run().changes;

			return changed ? this.get(id) : undefined;
		});
	}

	private static sameIdentity(row: OAuthAccountRow, identity: AccountIdentity): boolean {
		return row.providerUserId === identity.providerUserId && row.providerAccountId === (identity.providerAccountId ?? null);
	}

	/**
	 * Legacy single-credential write path (`ProviderSettings.upsertOAuth`). Updates the active
	 * account's credentials, or inserts an unverified account (no provider user ID, like migrated
	 * legacy rows) and activates it when none is active. Never fabricates a provider identity.
	 */
	static upsertActiveCredentials(
		provider: SubscriptionProvider,
		credentials: AccountCredentials,
		metadata: { email?: string | null; providerAccountId?: string | null } = {}
	): OAuthAccountRow {
		return getDb().transaction(() => {
			const now = Date.now();
			const active = this.active(provider);
			if (active) {
				const { accessToken, refreshToken, expiresAt } = credentials;
				getDb()
					.update(oauthAccounts)
					.set({
						accessToken,
						refreshToken,
						expiresAt,
						email: metadata.email ?? active.email,
						providerAccountId: metadata.providerAccountId ?? active.providerAccountId,
						credentialVersion: active.credentialVersion + 1,
						needsLogin: false,
						updatedAt: now
					})
					.where(eq(oauthAccounts.id, active.id))
					.run();

				return this.get(active.id)!;
			}
			const current = this.list(provider);
			const id = randomUUID();
			getDb()
				.insert(oauthAccounts)
				.values({
					id,
					provider,
					label: metadata.email ?? `${provider === 'claude' ? 'Claude' : 'ChatGPT'} account ${current.length + 1}`,
					email: metadata.email ?? null,
					providerAccountId: metadata.providerAccountId ?? null,
					accessToken: credentials.accessToken,
					refreshToken: credentials.refreshToken,
					expiresAt: credentials.expiresAt,
					createdAt: Math.max(now, ...current.map((row) => row.createdAt + 1)),
					updatedAt: now
				})
				.run();
			this.select(provider, id, undefined, 'first_account');

			return this.get(id)!;
		});
	}

	/**
	 * Saves a completed login. `snapshot` is the account list captured at login start:
	 * - an account present in the snapshot but deleted since is never recreated;
	 * - the same verified identity updates its existing row (credential version bumps, so any
	 *   in-flight refresh for the older generation is discarded by its CAS);
	 * - `reconnectId` must resolve to the same verified identity. Legacy rows migrated without
	 *   any identity (no provider user ID and no email) are adopted on explicit reconnect only.
	 * Login tokens are always newer than anything refreshed during the login window, so a credential
	 * version change since login start does not reject the login.
	 */
	static saveLogin(
		provider: SubscriptionProvider,
		credentials: AccountCredentials,
		identity: AccountIdentity,
		snapshot: LoginAccountSnapshot,
		reconnectId?: string
	): OAuthAccountRow {
		return getDb().transaction(() => {
			if (!identity.providerUserId) throw new Error('Provider did not return a verified user identity');
			const workspace = identity.providerAccountId ?? null;
			const matches = (row: OAuthAccountRow) =>
				this.sameIdentity(row, identity) ||
				(!row.providerUserId && !!row.email && row.email === identity.email && row.providerAccountId === workspace);
			const anonymousLegacy = (row: OAuthAccountRow) => !row.providerUserId && !row.email;
			const current = this.list(provider);
			let target: OAuthAccountRow | undefined;

			if (reconnectId) {
				const intended = snapshot.find((row) => row.id === reconnectId);
				if (!intended) throw new Error('Account not found');
				if (!matches(intended) && !anonymousLegacy(intended))
					throw new Error('Signed-in identity does not match the account being reconnected');
				target = current.find((row) => row.id === reconnectId);
				if (!target) throw new Error('Account was removed during login');
				const duplicate = current.find((row) => row.id !== reconnectId && matches(row));
				if (duplicate) throw new Error('Signed-in identity is already saved as another account');
			} else {
				target = current.find(matches);
				if (!target && snapshot.some(matches)) throw new Error('Account was removed during login');
			}

			const now = Date.now();
			const { accessToken, refreshToken, expiresAt } = credentials;
			if (target) {
				getDb()
					.update(oauthAccounts)
					.set({
						accessToken,
						refreshToken,
						expiresAt,
						providerUserId: identity.providerUserId,
						providerAccountId: workspace,
						email: identity.email ?? target.email,
						credentialVersion: target.credentialVersion + 1,
						needsLogin: false,
						updatedAt: now
					})
					.where(eq(oauthAccounts.id, target.id))
					.run();

				return this.get(target.id)!;
			}
			const id = randomUUID();
			// createdAt is the stable saved order; keep it strictly increasing so ties never fall back to random IDs.
			const createdAt = Math.max(now, ...current.map((row) => row.createdAt + 1));
			getDb()
				.insert(oauthAccounts)
				.values({
					id,
					provider,
					label: identity.email ?? `${provider === 'claude' ? 'Claude' : 'ChatGPT'} account ${current.length + 1}`,
					email: identity.email ?? null,
					providerUserId: identity.providerUserId,
					providerAccountId: workspace,
					accessToken,
					refreshToken,
					expiresAt,
					createdAt,
					updatedAt: now
				})
				.run();
			// The first account (or the first one saved while nothing is active) becomes active.
			if (!this.policy(provider).activeAccountId) this.select(provider, id, undefined, 'first_account');

			return this.get(id)!;
		});
	}
}
