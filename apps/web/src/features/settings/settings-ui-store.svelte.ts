import { getProviderLabel } from '@ungate/shared/frontend';

import { Api } from '$shared/api';

import type { ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

export enum ProviderAuthState {
	Authorized = 'authorized',
	NotAuthorized = 'not-authorized',
	Loading = 'loading'
}

interface SettingsUiStore {
	readonly selectedProvider: ModelMappingProvider;
	readonly authStates: Record<ModelMappingProvider, ProviderAuthState>;
	readonly providerLabels: Record<ModelMappingProvider, string>;
	getProviderModelsCount(models: ModelMappingConfig[]): (provider: ModelMappingProvider) => number;
	setSelectedProvider(provider: ModelMappingProvider): void;
	refreshAuthStates(): Promise<void>;
}

let selectedProvider = $state<ModelMappingProvider>('claude');

function createAuthStates(state: ProviderAuthState): Record<ModelMappingProvider, ProviderAuthState> {
	return {
		claude: state,
		openai: state,
		minimax: state
	};
}

let authStates = $state<Record<ModelMappingProvider, ProviderAuthState>>(createAuthStates(ProviderAuthState.Loading));

const providerLabels: Record<ModelMappingProvider, string> = {
	claude: getProviderLabel('claude'),
	openai: getProviderLabel('openai'),
	minimax: getProviderLabel('minimax')
};

function setSelectedProvider(provider: ModelMappingProvider): void {
	selectedProvider = provider;
}

function getProviderModelsCount(models: ModelMappingConfig[]): (provider: ModelMappingProvider) => number {
	return (provider) => models.filter((model) => model.provider === provider).length;
}

async function refreshAuthStates(): Promise<void> {
	authStates = createAuthStates(ProviderAuthState.Loading);

	try {
		const [claude, openai, minimax] = await Promise.all([Api.authStatus(), Api.authChatGPTStatus(), Api.authMinimaxStatus()]);
		authStates = {
			claude: claude.authenticated ? ProviderAuthState.Authorized : ProviderAuthState.NotAuthorized,
			openai: openai.authenticated ? ProviderAuthState.Authorized : ProviderAuthState.NotAuthorized,
			minimax: minimax.authenticated ? ProviderAuthState.Authorized : ProviderAuthState.NotAuthorized
		};
	} catch {
		authStates = createAuthStates(ProviderAuthState.NotAuthorized);
	}
}

export function getSettingsUiStore(): SettingsUiStore {
	const store: SettingsUiStore = {
		get selectedProvider() {
			return selectedProvider;
		},
		get authStates() {
			return authStates;
		},
		get providerLabels() {
			return providerLabels;
		},
		getProviderModelsCount,
		setSelectedProvider,
		refreshAuthStates
	};

	return store;
}
