import type { FastifyReply } from 'fastify';

/**
 * AbortSignal that fires when the downstream client goes away before the response finished
 * (socket closed while the reply is still unwritten/partially written). Used to cancel upstream
 * fetches and stop account fallback immediately.
 */
export function clientAbortSignal(reply: FastifyReply): AbortSignal {
	const controller = new AbortController();
	const raw = reply.raw;
	const onClose = () => {
		// `writableEnded`: the reply already called end() — a normal close, not a client abort.
		if (!raw.writableEnded && !raw.writableFinished) controller.abort(new Error('Client closed request'));
	};

	raw.once('close', onClose);

	return controller.signal;
}
