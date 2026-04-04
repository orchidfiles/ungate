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

export const modelMappings = sqliteTable('model_mappings', {
	id: text().primaryKey(),
	label: text().notNull(),
	provider: text().notNull(),
	upstreamModel: text().notNull(),
	enabled: integer({ mode: 'boolean' }).notNull().default(true),
	sortOrder: integer().notNull().default(0),
	reasoningBudget: text()
});

export const requests = sqliteTable('requests', {
	id: integer().primaryKey({ autoIncrement: true }),
	timestamp: integer().notNull(),
	model: text().notNull(),
	source: text().notNull(),
	inputTokens: integer().notNull().default(0),
	outputTokens: integer().notNull().default(0),
	estimatedCost: real().notNull().default(0),
	stream: integer({ mode: 'boolean' }).notNull().default(false),
	latencyMs: integer(),
	error: text()
});

export const schema = { appSettings, requests, providerSettings, modelMappings };
