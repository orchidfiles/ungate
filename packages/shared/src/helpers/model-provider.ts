import { type RequestSource, type ModelMappingProvider } from '../types';

export function detectProviderByModel(model: string): ModelMappingProvider {
	const normalized = model.trim().toLowerCase();

	if (normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
		return 'openai';
	}

	if (normalized.startsWith('minimax') || normalized.startsWith('mini-max')) {
		return 'minimax';
	}

	return 'claude';
}

export function detectProviderBySource(source: RequestSource): ModelMappingProvider | null {
	if (source === 'openai') {
		return 'openai';
	}

	if (source === 'minimax') {
		return 'minimax';
	}

	if (source === 'claude') {
		return 'claude';
	}

	return null;
}

export function detectProviderBySourceOrModel(source: RequestSource, model: string): ModelMappingProvider {
	const providerFromSource = detectProviderBySource(source);
	if (providerFromSource) {
		return providerFromSource;
	}

	return detectProviderByModel(model);
}
