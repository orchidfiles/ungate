import { SvelteSet } from 'svelte/reactivity';

import { Api } from '$shared/api';
import { DEFAULTS } from '$shared/constants';

import type { AnalyticsSummary, Period, RequestRecord } from '@ungate/shared/frontend';

interface AnalyticsStore {
	readonly summary: AnalyticsSummary | null;
	readonly requests: RequestRecord[];
	readonly filteredRequests: RequestRecord[];
	readonly availableModels: ModelOption[];
	period: Period;
	requestLimit: number;
	modelFilter: string;
	readonly loading: boolean;
	readonly error: string | null;
	load(): Promise<void>;
	reset(): Promise<void>;
}

let summary = $state<AnalyticsSummary | null>(null);
let requests = $state<RequestRecord[]>([]);
let period = $state<Period>(DEFAULTS.period);
let requestLimit = $state(DEFAULTS.requestLimit);
let modelFilter = $state('');
let loading = $state(false);
let error = $state<string | null>(null);

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

async function load(): Promise<void> {
	loading = true;
	error = null;
	await Promise.all([loadSummary(), loadRequests()]);
	loading = false;
}

async function reset(): Promise<void> {
	await Api.resetAnalytics();
	await load();
}

function filteredRequests(): RequestRecord[] {
	let result = requests;

	if (modelFilter) {
		result = result.filter((r) => r.model === modelFilter);
	}

	return result.slice(0, requestLimit);
}

export interface ModelOption {
	value: string;
	label: string;
}

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

	for (const r of requests) {
		if (!seen.has(r.model)) {
			seen.add(r.model);
			models.push({ value: r.model, label: formatModelName(r.model) });
		}
	}

	// Tier sort order: Opus=0, Sonnet=1, Haiku=2
	function tierOrder(label: string): number {
		if (label.toLowerCase().includes('opus')) return 0;
		if (label.toLowerCase().includes('sonnet')) return 1;
		if (label.toLowerCase().includes('haiku')) return 2;

		return 3;
	}

	function versionKey(label: string): string {
		// Extract version number for sorting: "Claude Opus 4.6" → "4.6"
		const match = /(\d+\.\d+)/.exec(label);

		return match ? match[1] : label;
	}

	const claudeModels = models
		.filter((m) => m.value.toLowerCase().startsWith('claude'))
		.sort((a, b) => {
			const tierDiff = tierOrder(a.label) - tierOrder(b.label);
			if (tierDiff !== 0) return tierDiff;

			return versionKey(b.label).localeCompare(versionKey(a.label)); // descending version
		});

	const minimaxModels = models
		.filter((m) => {
			const value = m.value.toLowerCase();

			return value.startsWith('minimax') || value.startsWith('mini-max');
		})
		.sort((a, b) => a.label.localeCompare(b.label));

	return [...claudeModels, ...minimaxModels];
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
		get availableModels() {
			return availableModels();
		},
		get period() {
			return period;
		},
		set period(v: Period) {
			period = v;
			void loadSummary();
		},
		get requestLimit() {
			return requestLimit;
		},
		set requestLimit(v: number) {
			requestLimit = v;
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
