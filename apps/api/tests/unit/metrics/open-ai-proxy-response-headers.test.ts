import { describe, expect, it, vi } from 'vitest';

import { OpenAiProxyResponseHeaders } from 'src/metrics';

describe('OpenAiProxyResponseHeaders', () => {
	it('sets OpenAI-compatible proxy response headers', () => {
		const header = vi.fn();
		const reply = { header } as { header: typeof header };

		OpenAiProxyResponseHeaders.apply(reply as never, 42);

		expect(header).toHaveBeenCalledTimes(3);
		expect(header.mock.calls[0][0]).toBe('x-request-id');
		expect(String(header.mock.calls[0][1])).toMatch(/^req_\d+$/);
		expect(header.mock.calls[1]).toEqual(['openai-processing-ms', '42']);
		expect(header.mock.calls[2]).toEqual(['openai-version', '2020-10-01']);
	});
});
