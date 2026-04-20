import { cloneDeep, orderBy, trim } from 'lodash-es';

import {
	isModelMappingProvider,
	isReasoningBudgetTier,
	type ModelMappingConfig,
	type ModelMappingProvider,
	type ReasoningBudgetTier
} from '@ungate/shared';

import { modelMappings } from './schema';

import { getDb } from './index';

export class ModelMappings {
	private static clone(models: ModelMappingConfig[]): ModelMappingConfig[] {
		return cloneDeep(models);
	}

	static sanitize(models: ModelMappingConfig[]): ModelMappingConfig[] {
		const sanitized: ModelMappingConfig[] = [];

		for (const [index, model] of models.entries()) {
			const trimmedId = trim(model.id);
			const trimmedLabel = trim(model.label);
			const trimmedUpstreamModel = trim(model.upstreamModel);
			let reasoningBudget: ReasoningBudgetTier | null = null;
			let provider: ModelMappingProvider = 'claude';

			if (isModelMappingProvider(model.provider)) {
				provider = model.provider;
			}

			if (isReasoningBudgetTier(model.reasoningBudget)) {
				reasoningBudget = model.reasoningBudget;
			}

			if (!trimmedId || !trimmedLabel || !trimmedUpstreamModel) {
				continue;
			}

			sanitized.push({
				id: trimmedId,
				label: trimmedLabel,
				provider,
				upstreamModel: trimmedUpstreamModel,
				sortOrder: index,
				reasoningBudget
			});
		}

		return sanitized;
	}

	static list(): ModelMappingConfig[] {
		const db = getDb();
		const rows = db.select().from(modelMappings).all();

		const models = orderBy(
			rows.map((row) => ({
				id: row.id,
				label: row.label,
				provider: isModelMappingProvider(row.provider) ? row.provider : 'claude',
				upstreamModel: row.upstreamModel,
				sortOrder: row.sortOrder,
				reasoningBudget: isReasoningBudgetTier(row.reasoningBudget) ? row.reasoningBudget : null
			})),
			['sortOrder'],
			['asc']
		);

		return this.clone(models);
	}

	static resolveForChatCompletion(requestedModel: string): ModelMappingConfig | null {
		const mappings = this.list();
		const t = requestedModel.trim();

		if (!t) {
			return null;
		}

		const byId = mappings.find((m) => m.id === t);

		if (byId) {
			return byId;
		}

		const byUpstream = mappings.find((m) => m.upstreamModel === t);

		if (byUpstream) {
			return byUpstream;
		}

		const lower = t.toLowerCase();
		const byIdInsensitive = mappings.find((m) => m.id.toLowerCase() === lower);

		if (byIdInsensitive) {
			return byIdInsensitive;
		}

		const byUpstreamInsensitive = mappings.find((m) => m.upstreamModel.toLowerCase() === lower);

		if (byUpstreamInsensitive) {
			return byUpstreamInsensitive;
		}

		return null;
	}

	static replace(models: ModelMappingConfig[]): void {
		const db = getDb();
		const sanitized = this.sanitize(models);
		db.transaction((tx) => {
			tx.delete(modelMappings).run();

			for (const model of sanitized) {
				tx.insert(modelMappings)
					.values({
						id: model.id,
						label: model.label,
						provider: model.provider,
						upstreamModel: model.upstreamModel,
						sortOrder: model.sortOrder,
						reasoningBudget: model.reasoningBudget
					})
					.run();
			}
		});
	}
}
