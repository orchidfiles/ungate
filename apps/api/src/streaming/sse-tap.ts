/** How a tapped stream ended. */
export type SseTapEnd = { kind: 'complete' } | { kind: 'aborted' } | { kind: 'failed'; error: unknown };

/** Reads a provider's events as they pass and turns the end of the stream into a summary. */
export interface SseTapReader<S> {
	/** Decoded text in arrival order; events may be split across calls. */
	read(text: string): void;
	finish(end: SseTapEnd): S;
}

/**
 * Byte-for-byte passthrough of an SSE body that lets `reader` see each chunk. `onEnd` runs exactly
 * once, when the stream completes, fails or the downstream client cancels; a cancel also cancels the
 * upstream body.
 */
export function tapSse<S>(
	body: ReadableStream<Uint8Array>,
	reader: SseTapReader<S>,
	onEnd: (summary: S) => void
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const upstream = body.getReader();
	let ended = false;

	const end = (how: SseTapEnd) => {
		if (ended) return;
		ended = true;
		onEnd(reader.finish(how));
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await upstream.read();
				if (done) {
					reader.read(decoder.decode());
					end({ kind: 'complete' });
					controller.close();

					return;
				}
				controller.enqueue(value);
				reader.read(decoder.decode(value, { stream: true }));
			} catch (error) {
				end({ kind: 'failed', error });
				controller.error(error);
			}
		},
		cancel(reason) {
			end({ kind: 'aborted' });

			return upstream.cancel(reason).catch(() => undefined);
		}
	});
}
