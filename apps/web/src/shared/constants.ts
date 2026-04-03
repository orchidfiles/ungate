import type { Period } from '@ungate/shared/frontend';

export const PERIODS: { value: Period; label: string }[] = [
	{ value: 'hour', label: 'Hour' },
	{ value: 'day', label: 'Day' },
	{ value: 'week', label: 'Week' },
	{ value: 'month', label: 'Month' },
	{ value: 'all', label: 'All Time' }
];

export const REQUEST_LIMITS = [20, 50, 100] as const;

export const DEFAULTS = {
	period: 'day' as Period,
	requestLimit: 20
};
