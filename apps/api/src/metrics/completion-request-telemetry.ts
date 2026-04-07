import { OpenAiProxyResponseHeaders } from './open-ai-proxy-response-headers';
import { RequestRecorder } from './request-recorder';

import type { RequestRecord } from '@ungate/shared';
import type { FastifyReply } from 'fastify';

export class CompletionRequestTelemetry {
	static recordAndApplyProxyHeaders(reply: FastifyReply, latencyMs: number, record: RequestRecord): void {
		RequestRecorder.record(record);
		OpenAiProxyResponseHeaders.apply(reply, latencyMs);
	}
}
