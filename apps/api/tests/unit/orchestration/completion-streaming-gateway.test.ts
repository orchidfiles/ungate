import { describe, expect, it, vi } from 'vitest';

import { CompletionStreamingGateway } from 'src/orchestration/openai';

describe('CompletionStreamingGateway', () => {
	it('copyUpstreamHeaders forwards headers but skips content-encoding', () => {
		const header = vi.fn();
		const reply = { header } as { header: typeof header };
		const res = new Response(null, {
			status: 200,
			headers: {
				'content-type': 'text/plain',
				'content-encoding': 'gzip',
				'x-custom': '1'
			}
		});

		CompletionStreamingGateway.copyUpstreamHeaders(reply as never, res);

		const keys = header.mock.calls.map((c) => String(c[0]).toLowerCase());

		expect(keys).toContain('content-type');
		expect(keys).toContain('x-custom');
		expect(keys).not.toContain('content-encoding');
	});
});
