import type { ModelMappingProvider } from '@ungate/shared/frontend';

export type DashboardPage = 'analytics' | 'settings' | 'logs';

interface WebviewState {
	currentPage?: DashboardPage;
	scrollPositions?: Partial<Record<DashboardPage, number>>;
	selectedSettingsProvider?: ModelMappingProvider;
	selectedSettingsModelIds?: Partial<Record<ModelMappingProvider, string>>;
}

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: WebviewState): void;
}

// acquireVsCodeApi() may only be called once — singleton
const vscodeApi = (
	window as Window & {
		acquireVsCodeApi?: () => VsCodeApi;
	}
).acquireVsCodeApi?.();

const dashboardPages: DashboardPage[] = ['analytics', 'settings', 'logs'];
const modelMappingProviders: ModelMappingProvider[] = ['claude', 'minimax', 'openai'];

function readWebviewState(): WebviewState {
	const state = vscodeApi?.getState();

	if (!state || typeof state !== 'object') {
		return {};
	}

	return state as WebviewState;
}

function updateWebviewState(update: Partial<WebviewState>): void {
	vscodeApi?.setState({ ...readWebviewState(), ...update });
}

export function postExtensionMessage(message: { type: string; [key: string]: unknown }): void {
	vscodeApi?.postMessage(message);
}

export function getSavedPage(): DashboardPage {
	const page = readWebviewState().currentPage;

	return page && dashboardPages.includes(page) ? page : 'analytics';
}

export function savePage(currentPage: DashboardPage): void {
	updateWebviewState({ currentPage });
}

export function getSavedScrollPosition(page: DashboardPage): number {
	const scrollPosition = readWebviewState().scrollPositions?.[page];

	return typeof scrollPosition === 'number' && Number.isFinite(scrollPosition) && scrollPosition >= 0 ? scrollPosition : 0;
}

export function saveScrollPosition(page: DashboardPage, scrollPosition: number): void {
	const scrollPositions = {
		...readWebviewState().scrollPositions,
		[page]: Math.max(0, scrollPosition)
	};

	updateWebviewState({ scrollPositions });
}

export function getSavedSettingsProvider(): ModelMappingProvider {
	const provider = readWebviewState().selectedSettingsProvider;

	return provider && modelMappingProviders.includes(provider) ? provider : 'claude';
}

export function saveSettingsProvider(selectedSettingsProvider: ModelMappingProvider): void {
	updateWebviewState({ selectedSettingsProvider });
}

export function getSavedSettingsModelId(provider: ModelMappingProvider): string | null {
	const modelId = readWebviewState().selectedSettingsModelIds?.[provider];

	return typeof modelId === 'string' && modelId ? modelId : null;
}

export function saveSettingsModelId(provider: ModelMappingProvider, modelId: string): void {
	const selectedSettingsModelIds = {
		...readWebviewState().selectedSettingsModelIds,
		[provider]: modelId
	};

	updateWebviewState({ selectedSettingsModelIds });
}
