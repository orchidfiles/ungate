import { describe, expect, it, vi } from 'vitest';

const recordMock = vi.hoisted(() => vi.fn());
const applyMock = vi.hoisted(() => vi.fn());

vi.mock('src/metrics/request-recorder', () => ({
	RequestRecorder: {
		record: (...args: unknown[]) => recordMock(...args)
	}
}));

vi.mock('src/metrics/open-ai-proxy-response-headers', () => ({
	OpenAiProxyResponseHeaders: {
		apply: (...args: unknown[]) => applyMock(...args)
	}
}));

import { CompletionRequestTelemetry } from 'src/metrics/completion-request-telemetry';

describe('CompletionRequestTelemetry', () => {
	it('calls record before apply with the same reply and latency', () => {
		const order: string[] = [];
		recordMock.mockImplementation(() => {
			order.push('record');
		});
		applyMock.mockImplementation(() => {
			order.push('apply');
		});

		const reply = { k: 1 } as never;
		const record = {
			model: 'm',
			source: 'claude' as const,
			inputTokens: 1,
			outputTokens: 2,
			stream: false,
			latencyMs: 99
		};

		CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, 99, record);

		expect(order).toEqual(['record', 'apply']);
		expect(recordMock).toHaveBeenCalledWith(record);
		expect(applyMock).toHaveBeenCalledWith(reply, 99);
	});
});
