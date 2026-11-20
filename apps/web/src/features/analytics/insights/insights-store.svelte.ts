import { Api } from '$shared/api';

import type { Period, UsageInsights } from '@ungate/shared/frontend';

export type InsightsTab = 'tokens' | 'accounts' | 'agents' | 'reliability';

let insights = $state<UsageInsights | null>(null);
let tab = $state<InsightsTab>('tokens');
let loading = $state(false);
let error = $state<string | null>(null);
/** Guards against an older period's response overwriting a newer one. */
let requestSeq = 0;

async function load(period: Period): Promise<void> {
	const seq = ++requestSeq;
	loading = true;
	error = null;

	try {
		const data = await Api.fetchInsights(period);
		if (seq === requestSeq) {
			insights = data;
		}
	} catch (e) {
		if (seq === requestSeq) {
			error = e instanceof Error ? e.message : String(e);
		}
	} finally {
		if (seq === requestSeq) {
			loading = false;
		}
	}
}

export const insightsStore = {
	get insights() {
		return insights;
	},
	get loading() {
		return loading;
	},
	get error() {
		return error;
	},
	get tab() {
		return tab;
	},
	set tab(value: InsightsTab) {
		tab = value;
	},
	load
};
