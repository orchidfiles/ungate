/** IPv4 loopback. `localhost` is ::1 here, and the API listens on IPv4 only. */
export function localApiBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

export function localApiHealthUrl(port: number): string {
	return `${localApiBaseUrl(port)}/health`;
}

function rejectAbort(reject: (reason?: unknown) => void): void {
	reject(new DOMException('Aborted', 'AbortError'));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			rejectAbort(reject);

			return;
		}

		const timer = setTimeout(() => {
			if (signal) {
				signal.removeEventListener('abort', onAbort);
			}

			resolve();
		}, ms);

		function onAbort(): void {
			clearTimeout(timer);

			if (signal) {
				signal.removeEventListener('abort', onAbort);
			}

			rejectAbort(reject);
		}

		if (signal) {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}
