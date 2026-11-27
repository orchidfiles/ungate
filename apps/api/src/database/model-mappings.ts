import { cloneDeep, orderBy, trim } from 'lodash-es';

import {
	isCursorToolMode,
	isModelMappingProvider,
	isModelServiceTier,
	isReasoningBudgetTier,
	type CursorToolMode,
	type ModelMappingConfig,
	type ModelMappingProvider,
	type ModelServiceTier,
	type ReasoningBudgetTier
} from '@ungate/shared';

import { modelMappings } from './schema';

import { getDb } from './index';

export class DuplicateModelIdError extends Error {
	constructor(readonly modelId: string) {
		super(`Model ID "${modelId}" is used more than once`);
		this.name = 'DuplicateModelIdError';
	}
}

export class ModelMappings {
	private static clone(models: ModelMappingConfig[]): ModelMappingConfig[] {
		return cloneDeep(models);
	}

	// Ids are the primary key, and Cursor also treats them as case-insensitive.
	private static assertUniqueIds(models: ModelMappingConfig[]): void {
		const seen = new Set<string>();

		for (const model of models) {
			const key = model.id.toLowerCase();

			if (seen.has(key)) {
				throw new DuplicateModelIdError(model.id);
			}

			seen.add(key);
		}
	}

	static sanitize(models: ModelMappingConfig[]): ModelMappingConfig[] {
		const sanitized: ModelMappingConfig[] = [];

		for (const [index, model] of models.entries()) {
			const trimmedId = trim(model.id);
			const trimmedLabel = trim(model.label);
			const trimmedUpstreamModel = trim(model.upstreamModel);
			let reasoningBudget: ReasoningBudgetTier | null = null;
			let serviceTier: ModelServiceTier | null = null;
			let toolMode: CursorToolMode | null = null;
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

			// Tool mode only matters for Cursor rows; `auto` is stored as null.
			if (provider === 'cursor' && isCursorToolMode(model.toolMode) && model.toolMode !== 'auto') {
				toolMode = model.toolMode;
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
				serviceTier,
				toolMode
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
				serviceTier: isModelServiceTier(row.serviceTier) ? row.serviceTier : null,
				toolMode: isCursorToolMode(row.toolMode) ? row.toolMode : null
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
	// When several tiers share the stripped id (`grok-4.7-medium` / `-high`), the effort Cursor
	// sent alongside picks the tier.
	private static findByDroppedReasoningSuffix(
		mappings: ModelMappingConfig[],
		lowerRequested: string,
		requestedEffort: string | null
	): ModelMappingConfig | null {
		const candidates = mappings.filter(
			(mapping) => mapping.reasoningBudget && mapping.id.toLowerCase() === `${lowerRequested}-${mapping.reasoningBudget}`
		);

		return candidates.find((mapping) => mapping.reasoningBudget === requestedEffort) ?? candidates[0] ?? null;
	}

	static resolveForChatCompletion(requestedModel: string, requestedEffort: string | null = null): ModelMappingConfig | null {
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
		const byDroppedSuffix = this.findByDroppedReasoningSuffix(mappings, lower, requestedEffort?.toLowerCase() ?? null);

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

	/** Appends one mapping after the existing rows. Throws DuplicateModelIdError on an id collision. */
	static append(model: Omit<ModelMappingConfig, 'sortOrder'>): ModelMappingConfig {
		const existing = this.list();
		const [sanitized] = this.sanitize([{ ...model, sortOrder: 0 }]);

		if (!sanitized) {
			throw new Error('Model mapping requires id, label and upstream model');
		}

		const next = { ...sanitized, sortOrder: existing.length };
		this.replace([...existing, next]);

		return next;
	}

	static replace(models: ModelMappingConfig[]): void {
		const db = getDb();
		const sanitized = this.sanitize(models);
		this.assertUniqueIds(sanitized);
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
						serviceTier: model.serviceTier,
						toolMode: model.toolMode ?? null
					})
					.run();
			}
		});
	}
}
