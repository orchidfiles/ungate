import { createServer, type Server, type ServerResponse } from 'node:http';

import { sleep } from '@ungate/shared';
import { config } from 'src/config';

import type { AddressInfo } from 'node:net';

/**
 * Loopback listener for Google's installed-app redirect. Google requires a loopback IP literal
 * redirect, and the port is ephemeral, so the redirect URI is only known after `start`.
 */
export class GeminiCallbackServer {
	private static callbackServer: Server | null = null;
	private static callbackShutdownAbort: AbortController | null = null;

	/** Starts the listener and returns the redirect URI to send to Google. */
	public static async start(
		onCallback: (requestUrl: string | undefined, path: string, response: ServerResponse) => Promise<void>,
		port = 0
	): Promise<string> {
		await this.stop();

		const path = config.gemini.oauth.callbackPath;
		const server = createServer((request, response) => {
			void onCallback(request.url, path, response);
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});

		this.callbackServer = server;
		this.callbackShutdownAbort = new AbortController();
		const shutdownSignal = this.callbackShutdownAbort.signal;
		void sleep(10 * 60 * 1000, shutdownSignal)
			.then(() => this.stop())
			.catch(() => {});

		return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
	}

	public static async stop(): Promise<void> {
		if (this.callbackShutdownAbort) {
			this.callbackShutdownAbort.abort();
			this.callbackShutdownAbort = null;
		}

		if (!this.callbackServer) {
			return;
		}

		const server = this.callbackServer;
		this.callbackServer = null;
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}
}
