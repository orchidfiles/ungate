import { z } from 'zod';

import {
	ClaudeCliVersion,
	isClaudeCliVersionMode,
	isCursorToolMode,
	isModelMappingProvider,
	isModelServiceTier,
	isReasoningBudgetTier,
	type AppSettings
} from '@ungate/shared';

import { Settings } from '../database/app-settings';
import { DuplicateModelIdError } from '../database/model-mappings';
import { logger } from '../utils/logger';

import type { Config } from '../config';
import type { FastifyPluginCallback } from 'fastify';

const ModelMappingUpdateSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		provider: z.string().refine((value) => isModelMappingProvider(value), {
			message: 'Model provider must be claude, openai, minimax or cursor'
		}),
		upstreamModel: z.string(),
		sortOrder: z.number().int(),
		reasoningBudget: z.union([
			z.null(),
			z.string().refine((value) => isReasoningBudgetTier(value), { message: 'Invalid reasoningBudget' })
		]),
		serviceTier: z
			.union([z.null(), z.string().refine((value) => isModelServiceTier(value), { message: 'Invalid serviceTier' })])
			.default(null),
		toolMode: z
			.union([z.null(), z.string().refine((value) => isCursorToolMode(value), { message: 'Invalid toolMode' })])
			.default(null)
	})
	.strip();

const SettingsUpdateSchema = z
	.object({
		port: z.number().int().min(1).max(65535).optional(),
		apiKey: z.union([z.string(), z.null()]).optional(),
		quiet: z.boolean().optional(),
		extraInstruction: z.union([z.string(), z.null()]).optional(),
		claudeCliVersionMode: z
			.string()
			.refine((value) => isClaudeCliVersionMode(value), { message: 'claudeCliVersionMode must be stable, latest, or custom' })
			.optional(),
		claudeCliVersionCustom: z.union([z.string(), z.null()]).optional(),
		models: z.array(ModelMappingUpdateSchema).optional()
	})
	.strip();

function validateSettingsUpdate(payload: unknown): { ok: true; value: Partial<AppSettings> } | { ok: false; error: string } {
	const result = SettingsUpdateSchema.safeParse(payload);

	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length ? ` at ${issue.path.join('.')}` : '';

		return { ok: false, error: `${issue.message}${path}` };
	}

	const value: Partial<AppSettings> = result.data;

	if (value.claudeCliVersionMode === 'custom') {
		const rawCustom = value.claudeCliVersionCustom ?? '';
		const customError = ClaudeCliVersion.validateCustomVersion(rawCustom);

		if (customError) {
			const errorResult: { ok: false; error: string } = { ok: false, error: customError };

			return errorResult;
		}

		value.claudeCliVersionCustom = rawCustom.trim();
	}

	const successResult: { ok: true; value: Partial<AppSettings> } = { ok: true, value };

	return successResult;
}

const plugin: FastifyPluginCallback = (app) => {
	app.get('/settings', async (_request, reply) => {
		const settings = Settings.get();

		return reply.send(settings);
	});

	app.post('/settings', async (request, reply) => {
		const validation = validateSettingsUpdate(request.body);

		if (!validation.ok) {
			logger.error(`Settings update failed: ${validation.error}`);

			return reply.code(400).send({ ok: false, error: validation.error });
		}

		try {
			Settings.update(validation.value);
		} catch (error) {
			if (error instanceof DuplicateModelIdError) {
				logger.error(`Settings update failed: ${error.message}`);

				return reply.code(400).send({ ok: false, error: error.message });
			}

			throw error;
		}

		// The model routes read the key from the running config on every request, so a rotated
		// key takes effect now, including in a service the extension adopted and cannot restart.
		if (validation.value.apiKey !== undefined) {
			const running: Config = app.config;
			running.apiKey = validation.value.apiKey ?? undefined;
		}

		return reply.send({ ok: true });
	});
};

export default plugin;
