import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
	id: integer()
		.primaryKey({ autoIncrement: false })
		.$defaultFn(() => 1),
	port: integer().notNull().default(47821),
	apiKey: text(),
	quiet: integer({ mode: 'boolean' }).notNull().default(false),
	extraInstruction: text()
});

export const requests = sqliteTable('requests', {
	id: integer().primaryKey({ autoIncrement: true }),
	timestamp: integer().notNull(),
	model: text().notNull(),
	source: text({ enum: ['claude_code', 'error'] }).notNull(),
	inputTokens: integer().notNull().default(0),
	outputTokens: integer().notNull().default(0),
	estimatedCost: real().notNull().default(0),
	stream: integer({ mode: 'boolean' }).notNull().default(false),
	latencyMs: integer(),
	error: text()
});

export const oauthTokens = sqliteTable('oauth_tokens', {
	id: integer().primaryKey({ autoIncrement: true }),
	accessToken: text().notNull(),
	refreshToken: text().notNull(),
	expiresAt: integer().notNull(),
	email: text(),
	createdAt: integer().notNull()
});

export const schema = { appSettings, requests, oauthTokens };
