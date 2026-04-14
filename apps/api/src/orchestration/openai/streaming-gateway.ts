import { MiniMaxStreamHandler } from 'src/streaming/minimax-stream-handler';
import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';

import type { FastifyReply } from 'fastify';
import type { RequestContext } from 'src/types/proxy';

export class CompletionStreamingGateway {
	static copyUpstreamHeaders(reply: FastifyReply, response: Response): void {
		for (const [key, value] of response.headers.entries()) {
			if (key.toLowerCase() === 'content-encoding') {
				continue;
			}

			reply.header(key, value);
		}
	}

	static sendMiniMaxStream(reply: FastifyReply, response: Response, minimaxModel: string, context: RequestContext): FastifyReply {
		CompletionStreamingGateway.copyUpstreamHeaders(reply, response);
		reply.code(response.status);

		const { stream, headers: streamHeaders } = MiniMaxStreamHandler.createStreamResponse(
			response,
			Date.now().toString(),
			minimaxModel,
			context
		);

		for (const [key, value] of Object.entries(streamHeaders)) {
			reply.header(key, value);
		}

		return reply.send(stream);
	}

	static sendOpenAiPassthroughStream(reply: FastifyReply, response: Response): FastifyReply {
		CompletionStreamingGateway.copyUpstreamHeaders(reply, response);
		reply.code(response.status);

		return reply.send(response.body);
	}

	static sendClaudeAsOpenAiStream(
		reply: FastifyReply,
		response: Response,
		streamId: string,
		openaiModel: string,
		context: RequestContext
	): FastifyReply {
		const { stream, headers: streamHeaders } = OpenAIStreamHandler.createStreamResponse(response, streamId, openaiModel, context);

		for (const [key, value] of Object.entries(streamHeaders)) {
			reply.header(key, value);
		}

		return reply.send(stream);
	}
}
