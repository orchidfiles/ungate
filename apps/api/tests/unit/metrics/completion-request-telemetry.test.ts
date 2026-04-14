import { describe, expect, it, vi } from 'vitest';

const requestRecordMock = vi.hoisted(() => vi.fn());

vi.mock('src/database/requests', () => ({
	Requests: {
		record: (...args: unknown[]) => requestRecordMock(...args)
	}
}));

import { CompletionRequestTelemetry } from 'src/metrics/completion-request-telemetry';

describe('CompletionRequestTelemetry', () => {
	it('calls record before apply with the same reply and latency', () => {
		const order: string[] = [];

		requestRecordMock.mockImplementation(() => {
			order.push('record');

			return 321;
		});

		const reply = {
			header: () => {
				order.push('apply');
			}
		} as never;
		const record = {
			model: 'm',
			source: 'claude' as const,
			inputTokens: 1,
			outputTokens: 2,
			stream: false,
			latencyMs: 99
		};

		const requestId = CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, 99, record);

		expect(order[0]).toBe('record');
		expect(order.slice(1)).toEqual(['apply', 'apply', 'apply']);
		expect(requestRecordMock).toHaveBeenCalledWith(record, undefined, undefined);
		expect(requestId).toBe(321);
	});
});
