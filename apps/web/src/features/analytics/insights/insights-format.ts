export const SERIES_COLORS = [
	'var(--color-primary-500)',
	'var(--color-secondary-500)',
	'var(--color-tertiary-500)',
	'var(--color-success-500)',
	'var(--color-warning-500)',
	'var(--color-error-500)',
	'var(--color-surface-400)'
];

/** Anthropic reports no thinking-token count; ~4 characters per token turns streamed thinking text into an estimate. */
export const CHARS_PER_TOKEN = 4;

export type PivotRow = Record<string, string | number | null> & { bucket: string };

/** Short x-axis label: `YYYY-MM-DD` → `MM-DD`, `YYYY-MM-DD HH:MM` → `HH:MM`. */
export function bucketLabel(bucket: string): string {
	const time = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2})$/.exec(bucket);
	if (time) return time[1];
	const day = /^\d{4}-(\d{2}-\d{2})$/.exec(bucket);

	return day ? day[1] : bucket;
}

/**
 * Turns long-form `{bucket, series, value}` rows into one row per bucket with a column per series.
 * Missing cells get `fill` (0 for stacked counts, null for rates so lines break instead of dropping to 0).
 */
export function pivot<T extends { bucket: string }>(
	points: T[],
	seriesOf: (point: T) => string,
	valueOf: (point: T) => number | null,
	fill: number | null = 0
): { rows: PivotRow[]; keys: string[] } {
	const keys: string[] = [];
	const rows = new Map<string, PivotRow>();

	for (const point of points) {
		const key = seriesOf(point);
		if (!keys.includes(key)) keys.push(key);
		const row = rows.get(point.bucket) ?? { bucket: bucketLabel(point.bucket) };
		row[key] = ((row[key] as number | null | undefined) ?? 0) + (valueOf(point) ?? 0);
		rows.set(point.bucket, row);
	}

	for (const row of rows.values()) {
		for (const key of keys) {
			if (!(key in row)) row[key] = fill;
		}
	}

	return { rows: [...rows.values()], keys };
}

export function seriesFor(keys: string[], labels?: (key: string) => string) {
	return keys.map((key, index) => ({
		key,
		label: labels ? labels(key) : key,
		color: SERIES_COLORS[index % SERIES_COLORS.length]
	}));
}

export function compact(value: number | null | undefined): string {
	if (value == null) return '—';

	return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function percent(value: number | null | undefined, digits = 0): string {
	if (value == null) return '—';

	return `${(value * 100).toFixed(digits)}%`;
}

export function duration(ms: number | null | undefined): string {
	if (ms == null) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;

	return `${(ms / 3_600_000).toFixed(1)}h`;
}
