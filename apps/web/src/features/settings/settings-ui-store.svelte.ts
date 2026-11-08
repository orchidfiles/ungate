import { getProviderLabel } from '@ungate/shared/frontend';

import { Api } from '$shared/api';
import { getSavedSettingsProvider, saveSettingsProvider } from '$shared/vscode';

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
	setAuthorized(provider: ModelMappingProvider, authorized: boolean | null): void;
}

let selectedProvider = $state<ModelMappingProvider>(getSavedSettingsProvider());

function createAuthStates(state: ProviderAuthState): Record<ModelMappingProvider, ProviderAuthState> {
	return {
		claude: state,
		openai: state,
		minimax: state,
		cursor: state
	};
}

let authStates = $state<Record<ModelMappingProvider, ProviderAuthState>>(createAuthStates(ProviderAuthState.Loading));

const providerLabels: Record<ModelMappingProvider, string> = {
	claude: getProviderLabel('claude'),
	openai: getProviderLabel('openai'),
	minimax: getProviderLabel('minimax'),
	cursor: getProviderLabel('cursor')
};

function setSelectedProvider(provider: ModelMappingProvider): void {
	selectedProvider = provider;
	saveSettingsProvider(provider);
}

function getProviderModelsCount(models: ModelMappingConfig[]): (provider: ModelMappingProvider) => number {
	return (provider) => models.filter((model) => model.provider === provider).length;
}

function toAuthState(authorized: boolean): ProviderAuthState {
	return authorized ? ProviderAuthState.Authorized : ProviderAuthState.NotAuthorized;
}

let refreshSeq = 0;

async function refreshAuthStates(): Promise<void> {
	const seq = ++refreshSeq;
	authStates = createAuthStates(ProviderAuthState.Loading);

	try {
		const [claude, openai, minimax, cursor] = await Promise.all([
			Api.authStatus(),
			Api.authChatGPTStatus(),
			Api.authMinimaxStatus(),
			Api.cursorStatus().catch(() => ({ connected: false }))
		]);

		if (seq !== refreshSeq) {
			return;
		}

		authStates = {
			claude: toAuthState(claude.authenticated),
			openai: toAuthState(openai.authenticated),
			minimax: toAuthState(minimax.authenticated),
			cursor: toAuthState(cursor.connected)
		};
	} catch {
		if (seq === refreshSeq) {
			authStates = createAuthStates(ProviderAuthState.NotAuthorized);
		}
	}
}

/**
 * Pushes a provider's state from a fresher source (the polled account list). Same semantics as the
 * legacy status endpoint: authorized when an active account exists and does not need login.
 * `null` (not loaded yet) leaves the current state untouched.
 */
function setAuthorized(provider: ModelMappingProvider, authorized: boolean | null): void {
	if (authorized === null) {
		return;
	}

	const next = toAuthState(authorized);

	if (authStates[provider] !== next) {
		authStates = { ...authStates, [provider]: next };
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
		refreshAuthStates,
		setAuthorized
	};

	return store;
}
