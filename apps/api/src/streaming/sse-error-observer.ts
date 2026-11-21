/**
 * Byte-for-byte passthrough of an Anthropic SSE body that watches for `error` events and reports
 * them once (post-commit: never retried). Downstream cancellation cancels the upstream body.
 */
export class SseErrorObserver {
	static observe(
		body: ReadableStream<Uint8Array>,
		onError: (error: Record<string, unknown> | undefined) => void
	): ReadableStream<Uint8Array> {
		const decoder = new TextDecoder();
		let buffer = '';
		let reported = false;

		const scan = (text: string) => {
			buffer += text;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (reported || !line.startsWith('data:') || !line.includes('"error"')) continue;
				try {
					const event = JSON.parse(line.slice(5).trim()) as { type?: unknown; error?: unknown };
					if (event.type !== 'error') continue;
					reported = true;
					onError(event.error && typeof event.error === 'object' ? (event.error as Record<string, unknown>) : undefined);
				} catch {
					// Not JSON: ignore.
				}
			}
			// Bound the carry-over for pathological lines.
			if (buffer.length > 256 * 1024) buffer = '';
		};

		const reader = body.getReader();

		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();

						return;
					}
					controller.enqueue(value);
					if (!reported) scan(decoder.decode(value, { stream: true }));
				} catch (error) {
					controller.error(error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason).catch(() => undefined);
			}
		});
	}
}
