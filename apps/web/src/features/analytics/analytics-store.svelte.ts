import { Api } from '$shared/api';
import { DEFAULTS } from '$shared/constants';

import type { AnalyticsSummary, Period, RequestRecord } from '@ungate/shared/frontend';

interface AnalyticsStore {
	readonly summary: AnalyticsSummary | null;
	readonly requests: RequestRecord[];
	readonly filteredRequests: RequestRecord[];
	readonly availableModels: string[];
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

function availableModels(): string[] {
	return [...new Set(requests.map((r) => r.model))];
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
