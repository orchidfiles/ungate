import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { isClientKind, type ClientKeyView, type ClientUsage } from '@ungate/shared';

import { clientKeys, requests } from './schema';

import { getDb } from './index';

/** Id of the one `settings` client, whose key is `app_settings.apiKey` (seeded by `_0016`). */
export const SETTINGS_CLIENT_ID = 'cursor';

const KEY_PREFIX = 'ug_';

/** Who presented a key on a model route. */
export type ClientResolution =
	| { kind: 'client'; clientId: string }
	/** No key exists at all, so the model routes are open; requests carry no client. */
	| { kind: 'open' }
	| { kind: 'refused' };

export class ClientNotFoundError extends Error {
	constructor(readonly clientId: string) {
		super(`Client "${clientId}" not found`);
		this.name = 'ClientNotFoundError';
	}
}

/** The settings client's key lives in Settings; it is rotated there, not revoked here. */
export class SettingsClientImmutableError extends Error {
	constructor() {
		super('The settings client is managed from Settings and cannot be revoked');
		this.name = 'SettingsClientImmutableError';
	}
}

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

function sameKey(presented: string, expected: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);

	return a.length === b.length && timingSafeEqual(a, b);
}

type ClientKeyRow = typeof clientKeys.$inferSelect;

function view(row: ClientKeyRow): ClientKeyView {
	if (!isClientKind(row.kind)) throw new Error(`client_keys row "${row.id}" has unknown kind "${row.kind}"`);

	return { id: row.id, kind: row.kind, label: row.label, createdAt: row.createdAt, revokedAt: row.revokedAt };
}

export class ClientKeys {
	static list(): ClientKeyView[] {
		return getDb().select().from(clientKeys).orderBy(asc(clientKeys.createdAt), asc(clientKeys.id)).all().map(view);
	}

	/** Mints a key for a new client. The returned key is the only copy; only its hash is stored. */
	static create(label: string): { client: ClientKeyView; key: string } {
		const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
		const row: ClientKeyRow = {
			id: randomUUID(),
			kind: 'minted',
			label,
			keyHash: hashKey(key),
			createdAt: Date.now(),
			revokedAt: null
		};

		getDb().insert(clientKeys).values(row).run();

		return { client: view(row), key };
	}

	static rename(id: string, label: string): ClientKeyView {
		const row = getDb().update(clientKeys).set({ label }).where(eq(clientKeys.id, id)).returning().get();
		if (!row) throw new ClientNotFoundError(id);

		return view(row);
	}

	/** Revoked keys are refused at once; the row stays so past requests keep their label. */
	static revoke(id: string): ClientKeyView {
		const db = getDb();
		const row = db.select().from(clientKeys).where(eq(clientKeys.id, id)).get();
		if (!row) throw new ClientNotFoundError(id);
		if (row.kind === 'settings') throw new SettingsClientImmutableError();
		if (row.revokedAt !== null) return view(row);

		return view(db.update(clientKeys).set({ revokedAt: Date.now() }).where(eq(clientKeys.id, id)).returning().get());
	}

	/**
	 * The single rule for model-route access. `settingsKey` is the running config's `apiKey`.
	 * Open only when there is no settings key and no active minted key, which keeps an install
	 * that never set a key working as before.
	 */
	static resolve(presented: string | undefined, settingsKey: string | undefined): ClientResolution {
		if (presented !== undefined && presented !== '') {
			if (settingsKey && sameKey(presented, settingsKey)) return { kind: 'client', clientId: SETTINGS_CLIENT_ID };

			const minted = getDb()
				.select({ id: clientKeys.id })
				.from(clientKeys)
				.where(and(eq(clientKeys.keyHash, hashKey(presented)), eq(clientKeys.kind, 'minted'), isNull(clientKeys.revokedAt)))
				.get();
			if (minted) return { kind: 'client', clientId: minted.id };
		}

		return settingsKey || this.anyActiveMinted() ? { kind: 'refused' } : { kind: 'open' };
	}

	private static anyActiveMinted(): boolean {
		return (
			getDb()
				.select({ id: clientKeys.id })
				.from(clientKeys)
				.where(and(eq(clientKeys.kind, 'minted'), isNull(clientKeys.revokedAt)))
				.limit(1)
				.get() !== undefined
		);
	}

	/** Requests and tokens per client in `[since, until]`, busiest first. */
	static usage(since: number, until: number): ClientUsage[] {
		return getDb()
			.select({
				clientId: requests.clientId,
				label: clientKeys.label,
				requests: sql<number>`COUNT(*)`,
				inputTokens: sql<number>`COALESCE(SUM(${requests.inputTokens}), 0)`,
				outputTokens: sql<number>`COALESCE(SUM(${requests.outputTokens}), 0)`,
				cacheReadTokens: sql<number>`COALESCE(SUM(${requests.cacheReadTokens}), 0)`,
				errors: sql<number>`SUM(CASE WHEN ${requests.source} = 'error' THEN 1 ELSE 0 END)`,
				lastRequestAt: sql<number | null>`MAX(${requests.timestamp})`
			})
			.from(requests)
			.leftJoin(clientKeys, eq(clientKeys.id, requests.clientId))
			.where(sql`${requests.timestamp} >= ${since} AND ${requests.timestamp} <= ${until}`)
			.groupBy(requests.clientId)
			.orderBy(sql`COUNT(*) DESC`)
			.all();
	}
}
