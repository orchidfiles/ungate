import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
	id: integer()
		.primaryKey({ autoIncrement: false })
		.$defaultFn(() => 1),
	port: integer().notNull().default(47821),
	apiKey: text(),
	quiet: integer({ mode: 'boolean' }).notNull().default(false),
	extraInstruction: text(),
	claudeCliVersionMode: text().notNull().default('stable'),
	claudeCliVersionCustom: text()
});

export const providerSettings = sqliteTable('provider_settings', {
	provider: text().primaryKey(),
	accessToken: text().notNull(),
	refreshToken: text(),
	expiresAt: integer(),
	email: text(),
	accountId: text(),
	createdAt: integer().notNull(),
	baseUrl: text()
});

export const oauthAccounts = sqliteTable('oauth_accounts', {
	id: text().primaryKey(),
	provider: text().notNull(),
	label: text().notNull(),
	email: text(),
	providerUserId: text(),
	providerAccountId: text(),
	accessToken: text().notNull(),
	refreshToken: text(),
	expiresAt: integer(),
	credentialVersion: integer().notNull().default(1),
	createdAt: integer().notNull(),
	updatedAt: integer().notNull(),
	cooldownUntil: integer(),
	cooldownReason: text(),
	cooldownEstimated: integer({ mode: 'boolean' }).notNull().default(false),
	needsLogin: integer({ mode: 'boolean' }).notNull().default(false),
	/** Last detected subscription tier (e.g. `plus`, `claude_max_20x`); used to notice upgrades. */
	planType: text()
});

export const oauthPolicies = sqliteTable('oauth_policies', {
	provider: text().primaryKey(),
	activeAccountId: text(),
	autoSwitch: integer({ mode: 'boolean' }).notNull().default(true),
	revision: integer().notNull().default(0),
	lastSwitchReason: text()
});

export const modelMappings = sqliteTable('model_mappings', {
	id: text().primaryKey(),
	label: text().notNull(),
	provider: text().notNull(),
	upstreamModel: text().notNull(),
	sortOrder: integer().notNull().default(0),
	reasoningBudget: text(),
	serviceTier: text(),
	/** Cursor tool schema mode override: `auto | structured | embedded`. Null = auto. */
	toolMode: text()
});

export const requests = sqliteTable(
	'requests',
	{
		id: integer().primaryKey({ autoIncrement: true }),
		timestamp: integer().notNull(),
		model: text().notNull(),
		source: text().notNull(),
		inputTokens: integer().notNull().default(0),
		outputTokens: integer().notNull().default(0),
		estimatedCost: real().notNull().default(0),
		stream: integer({ mode: 'boolean' }).notNull().default(false),
		latencyMs: integer(),
		error: text(),
		accountId: text(),
		attempts: integer(),
		rotationReason: text(),
		cacheReadTokens: integer(),
		cacheCreationTokens: integer(),
		reasoningTokens: integer(),
		reasoningChars: integer(),
		reasoningTier: text(),
		stopReason: text(),
		toolCallCount: integer(),
		toolNames: text(),
		sessionKey: text(),
		turnIndex: integer(),
		messageCount: integer(),
		continuation: integer({ mode: 'boolean' }),
		firstTokenMs: integer(),
		/** `client_keys.id` of the caller; null for rows recorded before clients existed or with auth off. */
		clientId: text()
	},
	(table) => [
		index('requests_timestamp_idx').on(table.timestamp),
		index('requests_session_key_idx').on(table.sessionKey, table.timestamp),
		index('requests_account_timestamp_idx').on(table.accountId, table.timestamp),
		index('requests_client_timestamp_idx').on(table.clientId, table.timestamp)
	]
);

/**
 * Callers of the model routes. `kind = 'settings'` is the one row whose key is `app_settings.api_key`
 * (the key pasted into Cursor); it has no hash here. `kind = 'minted'` rows hold only the SHA-256 of
 * a key shown once at creation.
 */
export const clientKeys = sqliteTable(
	'client_keys',
	{
		id: text().primaryKey(),
		kind: text().notNull(),
		label: text().notNull(),
		keyHash: text(),
		createdAt: integer().notNull(),
		revokedAt: integer()
	},
	(table) => [index('client_keys_key_hash_idx').on(table.keyHash)]
);

export const schema = { appSettings, requests, providerSettings, modelMappings, oauthAccounts, oauthPolicies, clientKeys };
