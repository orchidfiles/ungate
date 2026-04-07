import type { FastifyReply } from 'fastify';

export class OpenAiProxyResponseHeaders {
	static apply(reply: FastifyReply, latencyMs: number): void {
		reply.header('x-request-id', `req_${Date.now()}`);
		reply.header('openai-processing-ms', latencyMs.toString());
		reply.header('openai-version', '2020-10-01');
	}
}
