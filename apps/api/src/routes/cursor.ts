import { z } from 'zod';

import { isReasoningBudgetTier, type CursorModelInfo } from '@ungate/shared';

import { DuplicateModelIdError, ModelMappings } from '../database/model-mappings';
import { localOrApiKey } from '../plugins/local-or-api-key';
import { cursorBridgeClient } from '../proxy/cursor-bridge-client';

import type { FastifyPluginCallback } from 'fastify';

const importSchema = z.object({
	upstreamModel: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(/^[\w.:/-]+$/, 'Invalid Cursor model id'),
	label: z.string().trim().min(1).max(100),
	reasoningBudget: z
		.union([z.null(), z.string().refine((value) => isReasoningBudgetTier(value), { message: 'Invalid reasoningBudget' })])
		.optional()
});

/** Ungate model id for an imported Cursor model, e.g. `cursor-grok-4.7-low-fast`. */
export function cursorMappingId(upstreamModel: string): string {
	return `cursor-${upstreamModel.replace(/[^\w.-]+/g, '-').toLowerCase()}`;
}

/**
 * Cursor provider management. Responses carry only the safe session DTO and model metadata;
 * credentials never leave the extension host, so nothing here is credential-bearing.
 */
const plugin: FastifyPluginCallback = (app) => {
	const guard = { onRequest: localOrApiKey(app.config) };

	const statusHandler = async () => cursorBridgeClient.status();
	const modelsHandler = async () => {
		const { models, error } = await cursorBridgeClient.listModels();
		const imported = new Set(
			ModelMappings.list()
				.filter((m) => m.provider === 'cursor')
				.map((m) => m.upstreamModel.toLowerCase())
		);

		return {
			models: models.map((model: CursorModelInfo) => ({ ...model, imported: imported.has(model.id.toLowerCase()) })),
			error
		};
	};

	for (const prefix of ['', '/v1']) {
		app.get(`${prefix}/auth/cursor/status`, guard, statusHandler);
		app.get(`${prefix}/auth/cursor/models`, guard, modelsHandler);

		app.post(`${prefix}/auth/cursor/models/import`, guard, async (request, reply) => {
			const parsed = importSchema.safeParse(request.body ?? {});
			if (!parsed.success) {
				return reply
					.code(400)
					.send({ error: parsed.error.issues[0]?.message ?? 'Invalid import request', code: 'invalid_request' });
			}

			const { upstreamModel, label, reasoningBudget } = parsed.data;
			const id = cursorMappingId(upstreamModel) + (reasoningBudget ? `-${reasoningBudget}` : '');

			try {
				const model = ModelMappings.append({
					id,
					label,
					provider: 'cursor',
					upstreamModel,
					reasoningBudget: reasoningBudget ?? null,
					serviceTier: null,
					toolMode: null
				});

				return reply.send({ model, models: ModelMappings.list() });
			} catch (error) {
				if (error instanceof DuplicateModelIdError) {
					return reply.code(409).send({ error: `Model "${id}" is already imported`, code: 'duplicate_model' });
				}

				throw error;
			}
		});
	}
};

export default plugin;
