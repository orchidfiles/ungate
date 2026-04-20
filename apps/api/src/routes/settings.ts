import { z } from 'zod';

import { isModelMappingProvider, isReasoningBudgetTier, type AppSettings } from '@ungate/shared';

import { Settings } from '../database/app-settings';

import type { FastifyPluginCallback } from 'fastify';

const ModelMappingUpdateSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		provider: z.string().refine((value) => isModelMappingProvider(value), {
			message: 'Model provider must be claude, openai or minimax'
		}),
		upstreamModel: z.string(),
		sortOrder: z.number().int(),
		reasoningBudget: z.union([
			z.null(),
			z.string().refine((value) => isReasoningBudgetTier(value), { message: 'Invalid reasoningBudget' })
		])
	})
	.strict();

const SettingsUpdateSchema = z
	.object({
		port: z.number().int().min(1).max(65535).optional(),
		apiKey: z.union([z.string(), z.null()]).optional(),
		quiet: z.boolean().optional(),
		extraInstruction: z.union([z.string(), z.null()]).optional(),
		models: z.array(ModelMappingUpdateSchema).optional()
	})
	.strict();

function validateSettingsUpdate(payload: unknown): { ok: true; value: Partial<AppSettings> } | { ok: false; error: string } {
	const result = SettingsUpdateSchema.safeParse(payload);

	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length ? ` at ${issue.path.join('.')}` : '';

		return { ok: false, error: `${issue.message}${path}` };
	}

	return { ok: true, value: result.data };
}

const plugin: FastifyPluginCallback = (app) => {
	app.get('/settings', async (_request, reply) => {
		const settings = Settings.get();

		return reply.send(settings);
	});

	app.post('/settings', async (request, reply) => {
		const validation = validateSettingsUpdate(request.body);

		if (!validation.ok) {
			return reply.code(400).send({ ok: false, error: validation.error });
		}

		Settings.update(validation.value);

		return reply.send({ ok: true });
	});
};

export default plugin;
