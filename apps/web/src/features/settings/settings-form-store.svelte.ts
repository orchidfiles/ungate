import { ClaudeCliVersion } from '@ungate/shared/frontend';
import { SvelteSet } from 'svelte/reactivity';

import type { AppSettings, ClaudeCliVersionMode, ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

interface SettingsFormStore {
	readonly port: string;
	readonly apiKey: string;
	readonly quiet: boolean;
	readonly extraInstruction: string;
	readonly models: ModelMappingConfig[];
	readonly claudeCliVersionMode: ClaudeCliVersionMode;
	readonly claudeCliVersionCustom: string;
	setPort(value: string): void;
	setApiKey(value: string): void;
	setQuiet(value: boolean): void;
	setExtraInstruction(value: string): void;
	setModels(models: ModelMappingConfig[]): void;
	setClaudeCliVersionMode(mode: ClaudeCliVersionMode): void;
	setClaudeCliVersionCustom(value: string): void;
	syncFromAppSettings(settings: AppSettings): void;
	validate(): string | null;
	toSavePayload(): Partial<AppSettings>;
}

let port = $state('');
let apiKey = $state('');
let quiet = $state(false);
let extraInstruction = $state('');
let models = $state<ModelMappingConfig[]>([]);
let claudeCliVersionMode = $state<ClaudeCliVersionMode>('stable');
let claudeCliVersionCustom = $state('');

function cloneModels(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => {
		let reasoningBudget = model.reasoningBudget;
		let serviceTier = model.serviceTier;
		let provider: ModelMappingProvider = 'claude';

		if (model.provider === 'minimax') {
			provider = 'minimax';
		}

		if (model.provider === 'openai') {
			provider = 'openai';
		}

		if (model.provider === 'cursor') {
			provider = 'cursor';
		}

		const toolMode =
			provider === 'cursor' && (model.toolMode === 'structured' || model.toolMode === 'embedded') ? model.toolMode : null;

		if (
			reasoningBudget !== 'none' &&
			reasoningBudget !== 'low' &&
			reasoningBudget !== 'medium' &&
			reasoningBudget !== 'high' &&
			reasoningBudget !== 'xhigh' &&
			reasoningBudget !== 'max'
		) {
			reasoningBudget = null;
		}

		if (serviceTier !== 'default' && serviceTier !== 'priority') {
			serviceTier = null;
		}

		return { ...model, provider, reasoningBudget, serviceTier, toolMode, sortOrder: index };
	});
}

function withSortOrder(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => ({ ...model, sortOrder: index }));
}

function syncFromAppSettings(settings: AppSettings): void {
	port = String(settings.port);
	apiKey = settings.apiKey ?? '';
	quiet = settings.quiet;
	extraInstruction = settings.extraInstruction ?? '';
	claudeCliVersionMode = settings.claudeCliVersionMode ?? 'stable';
	claudeCliVersionCustom = settings.claudeCliVersionCustom ?? '';
	models = cloneModels(settings.models);
}

function setPort(value: string): void {
	port = value;
}

function setApiKey(value: string): void {
	apiKey = value;
}

function setQuiet(value: boolean): void {
	quiet = value;
}

function setExtraInstruction(value: string): void {
	extraInstruction = value;
}

function setModels(nextModels: ModelMappingConfig[]): void {
	models = withSortOrder(nextModels);
}

function setClaudeCliVersionMode(mode: ClaudeCliVersionMode): void {
	claudeCliVersionMode = mode;
}

function setClaudeCliVersionCustom(value: string): void {
	claudeCliVersionCustom = value;
}

function validate(): string | null {
	const parsedPort = parseInt(port, 10);

	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		return 'Port must be an integer between 1 and 65535.';
	}

	const seenIds = new SvelteSet<string>();

	for (const model of models) {
		const modelId = model.id.trim();

		if (!modelId) {
			return 'Every model must have a Model ID.';
		}

		const idKey = modelId.toLowerCase();

		if (seenIds.has(idKey)) {
			return `Model ID "${modelId}" is used more than once.`;
		}

		seenIds.add(idKey);

		if (!model.label.trim()) {
			return `Model "${modelId}" must have a label.`;
		}

		if (!model.upstreamModel.trim()) {
			return `Model "${model.id}" must have an upstream model.`;
		}
	}

	if (claudeCliVersionMode === 'custom') {
		const customError = ClaudeCliVersion.validateCustomVersion(claudeCliVersionCustom);

		if (customError) {
			return customError;
		}
	}

	return null;
}

function toSavePayload(): Partial<AppSettings> {
	const parsedPort = parseInt(port, 10);
	const payload: Partial<AppSettings> = {
		port: parsedPort,
		quiet,
		apiKey: apiKey.trim() || null,
		extraInstruction: extraInstruction.trim() || null,
		claudeCliVersionMode,
		claudeCliVersionCustom: claudeCliVersionCustom.trim() || null,
		models: cloneModels(models)
	};

	return payload;
}

export function getSettingsFormStore(): SettingsFormStore {
	const store: SettingsFormStore = {
		get port() {
			return port;
		},
		get apiKey() {
			return apiKey;
		},
		get quiet() {
			return quiet;
		},
		get extraInstruction() {
			return extraInstruction;
		},
		get models() {
			return models;
		},
		get claudeCliVersionMode() {
			return claudeCliVersionMode;
		},
		get claudeCliVersionCustom() {
			return claudeCliVersionCustom;
		},
		setPort,
		setApiKey,
		setQuiet,
		setExtraInstruction,
		setModels,
		setClaudeCliVersionMode,
		setClaudeCliVersionCustom,
		syncFromAppSettings,
		validate,
		toSavePayload
	};

	return store;
}
