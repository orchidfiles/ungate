import {
	detectProviderBySourceOrModel,
	getProviderLabel,
	type AnalyticsSummary,
	type ModelMappingProvider,
	type Period,
	type RequestRecord,
	type TokenSeriesPoint
} from '@ungate/shared/frontend';
import { SvelteSet } from 'svelte/reactivity';

import { Api } from '$shared/api';
import { DEFAULTS } from '$shared/constants';

interface AnalyticsStore {
	readonly summary: AnalyticsSummary | null;
	readonly requests: RequestRecord[];
	readonly filteredRequests: RequestRecord[];
	readonly tokenSeries: TokenSeriesPoint[];
	readonly availableProviders: ProviderOption[];
	readonly availableModels: ModelOption[];
	period: Period;
	requestLimit: number;
	providerFilter: ProviderFilter;
	modelFilter: string;
	readonly loading: boolean;
	readonly error: string | null;
	load(): Promise<void>;
	reset(): Promise<void>;
}

export type ProviderFilter = 'all' | ModelMappingProvider;

interface ConfiguredModelEntry {
	id: string;
	label: string;
	upstreamModel: string;
	provider: ModelMappingProvider;
}

let summary = $state<AnalyticsSummary | null>(null);
let requests = $state<RequestRecord[]>([]);
let tokenSeries = $state<TokenSeriesPoint[]>([]);
let configuredModels = $state<ConfiguredModelEntry[]>([]);
let period = $state<Period>(DEFAULTS.period);
let requestLimit = $state(DEFAULTS.requestLimit);
let providerFilter = $state<ProviderFilter>('all');
let modelFilter = $state('');
let loading = $state(false);
let error = $state<string | null>(null);

const detectProviderBySourceOrModelTyped = detectProviderBySourceOrModel as (
	source: RequestRecord['source'],
	model: string
) => ModelMappingProvider;
const apiTyped = Api as {
	fetchTokenSeries(selectedPeriod: Period): Promise<{ period: Period; series: TokenSeriesPoint[] }>;
};

function extractError(e: unknown): string {
	if (e instanceof Error) {
		return e.message;
	}

	return String(e);
}

async function loadSummary(): Promise<void> {
	try {
		summary = await Api.fetchAnalytics(period);
	} catch (e) {
		error = extractError(e);
	}
}

async function loadRequests(): Promise<void> {
	try {
		const data = await Api.fetchRequests(100);
		requests = data.requests;
	} catch (e) {
		error = extractError(e);
	}
}

async function loadTokenSeries(): Promise<void> {
	try {
		const data = await apiTyped.fetchTokenSeries(period);
		tokenSeries = data.series;
	} catch (e) {
		error = extractError(e);
	}
}

async function loadConfiguredModels(): Promise<void> {
	try {
		const settings = await Api.fetchSettings();
		configuredModels = settings.models
			.filter((model) => model.id.trim().length > 0)
			.map((model) => ({
				id: model.id,
				label: model.label,
				upstreamModel: model.upstreamModel,
				provider: model.provider
			}));
	} catch {
		configuredModels = [];
	}
}

async function load(): Promise<void> {
	loading = true;
	error = null;
	await Promise.all([loadSummary(), loadRequests(), loadConfiguredModels(), loadTokenSeries()]);
	loading = false;
}

async function reset(): Promise<void> {
	await Api.resetAnalytics();
	await load();
}

function filteredRequests(): RequestRecord[] {
	let result = requests;

	if (providerFilter !== 'all') {
		result = result.filter((r) => resolveProviderByRecord(r) === providerFilter);
	}

	if (modelFilter) {
		const configuredMatch = configuredModels.find((model) => model.id === modelFilter);

		if (!configuredMatch) {
			result = result.filter((r) => r.model === modelFilter);
		} else if (configuredMatch.provider !== 'openai') {
			result = result.filter((r) => r.model === modelFilter);
		} else {
			const candidateModels = new SvelteSet<string>();
			candidateModels.add(modelFilter);

			if (configuredMatch.upstreamModel.trim().length > 0) {
				candidateModels.add(configuredMatch.upstreamModel);
			}

			result = result.filter((r) => candidateModels.has(r.model));
		}
	}

	return result.slice(0, requestLimit);
}

export interface ModelOption {
	value: string;
	label: string;
}

export interface ProviderOption {
	value: ProviderFilter;
	label: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
	{ value: 'all', label: 'All Providers' },
	{ value: 'claude', label: getProviderLabel('claude') },
	{ value: 'openai', label: getProviderLabel('openai') },
	{ value: 'minimax', label: getProviderLabel('minimax') }
];

// Labels map — exact model names from DB (after normalizeModelName).
// Dated variants are the actual stored names for 4.5 models.
const MODEL_LABELS: Record<string, string> = {
	// 4.6 series (used as-is)
	'claude-opus-4-6': 'Claude Opus 4.6',
	'claude-sonnet-4-6': 'Claude Sonnet 4.6',
	// 4.5 series — dated variants (these are what normalizeModelName actually stores)
	'claude-opus-4-5-20251101': 'Claude Opus 4.5',
	'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
	'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
	// 4 series (legacy)
	'claude-opus-4': 'Claude Opus 4',
	'claude-sonnet-4': 'Claude Sonnet 4',
	'claude-haiku-4': 'Claude Haiku 4',
	// 3.5 series
	'claude-opus-3-5': 'Claude Opus 3.5',
	'claude-sonnet-3-5': 'Claude Sonnet 3.5',
	'claude-haiku-3-5': 'Claude Haiku 3.5',
	// 3 series
	'claude-opus-3': 'Claude Opus 3',
	'claude-sonnet-3': 'Claude Sonnet 3',
	'claude-haiku-3': 'Claude Haiku 3',
	// MiniMax
	'MiniMax-Lite': 'MiniMax Lite',
	MiniMax: 'MiniMax'
};

// Pretty-print a raw model name.
// Handles dated suffixes (e.g. "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5")
// and legacy names without dates.
export function formatModelName(raw: string): string {
	const label = MODEL_LABELS[raw];

	if (label) {
		return label;
	}

	// Strip date suffix from Claude model names: "claude-sonnet-4-5-20250929" → try "claude-sonnet-4-5"
	const datedMatch = /^((?:claude-[\w]+-[\w]+)-[\d]+)$/.exec(raw);
	if (datedMatch) {
		const withoutDate = datedMatch[1];

		if (MODEL_LABELS[withoutDate]) {
			return MODEL_LABELS[withoutDate];
		}
	}

	// Generic Claude name cleanup: "claude-sonnet-4" → "Claude Sonnet 4"
	const genericMatch = /^claude-(opus|sonnet|haiku)-(\d+)$/i.exec(raw);
	if (genericMatch) {
		const [, tier, version] = genericMatch;

		return `Claude ${tier.charAt(0).toUpperCase() + tier.slice(1)} ${version}`;
	}

	const miniMaxMatch = /^MiniMax-([A-Za-z0-9.]+)$/i.exec(raw);
	if (miniMaxMatch) {
		return `MiniMax ${miniMaxMatch[1]}`;
	}

	return raw;
}

function availableModels(): ModelOption[] {
	const seen = new SvelteSet<string>();
	const models: ModelOption[] = [];

	for (const model of configuredModels) {
		if (providerFilter !== 'all' && model.provider !== providerFilter) {
			continue;
		}

		if (!seen.has(model.id)) {
			seen.add(model.id);
			models.push({
				value: model.id,
				label: model.label.trim().length > 0 ? model.label : formatModelName(model.id)
			});
		}
	}

	for (const r of requests) {
		if (providerFilter !== 'all' && resolveProviderByRecord(r) !== providerFilter) {
			continue;
		}

		if (!seen.has(r.model)) {
			seen.add(r.model);
			models.push({ value: r.model, label: formatModelName(r.model) });
		}
	}

	return models;
}

function resolveProviderByRecord(record: RequestRecord): ModelMappingProvider {
	const configured = configuredModels.find((item) => item.id === record.model);
	if (configured) {
		return configured.provider;
	}

	return detectProviderBySourceOrModelTyped(record.source, record.model);
}

function validateModelFilter(): void {
	if (!modelFilter) {
		return;
	}

	const hasCurrentModel = availableModels().some((model) => model.value === modelFilter);
	if (!hasCurrentModel) {
		modelFilter = '';
	}
}

export function getAnalyticsStore(): AnalyticsStore {
	const store: AnalyticsStore = {
		get summary() {
			return summary;
		},
		get requests() {
			return requests;
		},
		get filteredRequests() {
			return filteredRequests();
		},
		get availableProviders() {
			return PROVIDER_OPTIONS;
		},
		get availableModels() {
			return availableModels();
		},
		get period() {
			return period;
		},
		set period(v: Period) {
			period = v;
			void loadSummary();
			void loadTokenSeries();
		},
		get tokenSeries() {
			return tokenSeries;
		},
		get requestLimit() {
			return requestLimit;
		},
		set requestLimit(v: number) {
			requestLimit = v;
		},
		get providerFilter() {
			return providerFilter;
		},
		set providerFilter(v: ProviderFilter) {
			providerFilter = v;
			validateModelFilter();
		},
		get modelFilter() {
			return modelFilter;
		},
		set modelFilter(v: string) {
			modelFilter = v;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		load,
		reset
	};

	return store;
}
