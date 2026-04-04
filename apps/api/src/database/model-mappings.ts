import { type ClaudeReasoningBudget, type ModelMappingConfig, type ModelMappingProvider } from '@ungate/shared';

import { modelMappings } from './schema';

import { getDb } from './index';

export class ModelMappings {
	private static clone(models: ModelMappingConfig[]): ModelMappingConfig[] {
		return models.map((model) => ({ ...model }));
	}

	private static isProvider(value: unknown): value is ModelMappingProvider {
		if (value === 'claude') {
			return true;
		}

		if (value === 'minimax') {
			return true;
		}

		return false;
	}

	private static isReasoningBudget(value: unknown): value is ClaudeReasoningBudget {
		if (value === 'low') {
			return true;
		}

		if (value === 'medium') {
			return true;
		}

		if (value === 'high') {
			return true;
		}

		return false;
	}

	static sanitize(models: ModelMappingConfig[]): ModelMappingConfig[] {
		const sanitized: ModelMappingConfig[] = [];

		for (const [index, model] of models.entries()) {
			const trimmedId = model.id.trim();
			const trimmedLabel = model.label.trim();
			const trimmedUpstreamModel = model.upstreamModel.trim();
			let reasoningBudget: ClaudeReasoningBudget | null = null;
			let provider: ModelMappingProvider = 'claude';

			if (this.isProvider(model.provider)) {
				provider = model.provider;
			}

			if (this.isReasoningBudget(model.reasoningBudget)) {
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
				enabled: Boolean(model.enabled),
				sortOrder: index,
				reasoningBudget
			});
		}

		return sanitized;
	}

	static list(): ModelMappingConfig[] {
		const db = getDb();
		const rows = db.select().from(modelMappings).all();

		const models = rows
			.map((row) => ({
				id: row.id,
				label: row.label,
				provider: this.isProvider(row.provider) ? row.provider : 'claude',
				upstreamModel: row.upstreamModel,
				enabled: row.enabled,
				sortOrder: row.sortOrder,
				reasoningBudget: this.isReasoningBudget(row.reasoningBudget) ? row.reasoningBudget : null
			}))
			.sort((a, b) => a.sortOrder - b.sortOrder);

		return this.clone(models);
	}

	static replace(models: ModelMappingConfig[]): void {
		const db = getDb();
		const sanitized = this.sanitize(models);

		db.delete(modelMappings).run();

		for (const model of sanitized) {
			db.insert(modelMappings)
				.values({
					id: model.id,
					label: model.label,
					provider: model.provider,
					upstreamModel: model.upstreamModel,
					enabled: model.enabled,
					sortOrder: model.sortOrder,
					reasoningBudget: model.reasoningBudget
				})
				.run();
		}
	}
}
