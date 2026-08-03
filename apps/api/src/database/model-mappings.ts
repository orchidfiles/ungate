import { cloneDeep, orderBy, trim } from 'lodash-es';

import {
	isModelMappingProvider,
	isModelServiceTier,
	isReasoningBudgetTier,
	type ModelMappingConfig,
	type ModelMappingProvider,
	type ModelServiceTier,
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
			let serviceTier: ModelServiceTier | null = null;
			let provider: ModelMappingProvider = 'claude';

			if (isModelMappingProvider(model.provider)) {
				provider = model.provider;
			}

			if (isReasoningBudgetTier(model.reasoningBudget)) {
				reasoningBudget = model.reasoningBudget;
			}

			if (isModelServiceTier(model.serviceTier)) {
				serviceTier = model.serviceTier;
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
				reasoningBudget,
				serviceTier
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
				reasoningBudget: isReasoningBudgetTier(row.reasoningBudget) ? row.reasoningBudget : null,
				serviceTier: isModelServiceTier(row.serviceTier) ? row.serviceTier : null
			})),
			['sortOrder'],
			['asc']
		);

		return this.clone(models);
	}

	// Cursor drops a trailing reasoning tier from the model id and sends the effort as a
	// separate field, so a mapping saved as "gpt-5.6-sol-fast-medium" arrives as
	// "gpt-5.6-sol-fast". Only re-attach a suffix that matches the row's own budget, and
	// keep sortOrder precedence so the first matching mapping wins.
	private static findByDroppedReasoningSuffix(mappings: ModelMappingConfig[], lowerRequested: string): ModelMappingConfig | null {
		for (const mapping of mappings) {
			if (!mapping.reasoningBudget) {
				continue;
			}

			if (mapping.id.toLowerCase() === `${lowerRequested}-${mapping.reasoningBudget}`) {
				return mapping;
			}
		}

		return null;
	}

	static resolveForChatCompletion(requestedModel: string): ModelMappingConfig | null {
		const mappings = this.list();
		const t = requestedModel.trim();

		if (!t) {
			return null;
		}

		const lower = t.toLowerCase();

		// Ids are what users configure in Cursor, so every id match outranks upstream matches.
		const byId = mappings.find((m) => m.id === t) ?? mappings.find((m) => m.id.toLowerCase() === lower);

		if (byId) {
			return byId;
		}

		// Must stay ahead of the upstream match: mappings that differ only by service tier
		// share one upstream model, so matching upstream first collapses the priority-tier
		// row onto the default-tier one.
		const byDroppedSuffix = this.findByDroppedReasoningSuffix(mappings, lower);

		if (byDroppedSuffix) {
			return byDroppedSuffix;
		}

		const byUpstream =
			mappings.find((m) => m.upstreamModel === t) ?? mappings.find((m) => m.upstreamModel.toLowerCase() === lower);

		if (byUpstream) {
			return byUpstream;
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
						reasoningBudget: model.reasoningBudget,
						serviceTier: model.serviceTier
					})
					.run();
			}
		});
	}
}
