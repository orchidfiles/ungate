import { Requests } from 'src/database/requests';

import type { RequestRecord } from '@ungate/shared';
import type { FastifyReply } from 'fastify';

export class CompletionRequestTelemetry {
	static recordAndApplyProxyHeaders(
		reply: FastifyReply,
		latencyMs: number,
		record: RequestRecord,
		cacheReadTokens?: number,
		cacheCreationTokens?: number
	): number {
		const requestId = this.record(record, cacheReadTokens, cacheCreationTokens);
		this.applyProxyHeaders(reply, latencyMs);

		return requestId;
	}

	static record(record: RequestRecord, cacheReadTokens?: number, cacheCreationTokens?: number): number {
		return Requests.record(record, cacheReadTokens, cacheCreationTokens);
	}

	static applyProxyHeaders(reply: FastifyReply, latencyMs: number): void {
		reply.header('x-request-id', `req_${Date.now()}`);
		reply.header('openai-processing-ms', latencyMs.toString());
		reply.header('openai-version', '2020-10-01');
	}
}
