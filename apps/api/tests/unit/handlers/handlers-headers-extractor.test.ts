import { describe, expect, it } from 'vitest';

import { HeadersExtractor } from 'src/handlers/headers-extractor';

describe('headers-extractor', () => {
	it('extracts anthropic passthrough headers with default version', () => {
		const out = HeadersExtractor.extractAnthropicHeaders({
			'anthropic-beta': ['a', 'b']
		});
		expect(out).toEqual({
			'anthropic-beta': 'a, b',
			'anthropic-version': '2023-06-01'
		});
	});

	it('keeps explicit anthropic version', () => {
		const out = HeadersExtractor.extractAnthropicHeaders({
			'anthropic-version': '2025-01-01'
		});
		expect(out['anthropic-version']).toBe('2025-01-01');
	});
});
