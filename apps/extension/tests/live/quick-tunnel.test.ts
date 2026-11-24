import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';
import type { AddressInfo } from 'node:net';

/**
 * Runs the real TunnelManager against the real pinned cloudflared and Cloudflare's quick tunnel
 * service. HOME is replaced before any Ungate module loads, so the binary, the runtime state file
 * and the log land in a throwaway directory and a tunnel the developer has running is left alone.
 */
const isolatedHome = await vi.hoisted(async () => {
	const fsModule = await import('node:fs');
	const osModule = await import('node:os');
	const pathModule = await import('node:path');
	const home = fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'ungate-live-home-'));

	process.env.HOME = home;
	process.env.USERPROFILE = home;

	return home;
});

const { CloudflaredProcess, RuntimeStateStore } = await import('../../src/runtime-state');
const { TunnelManager } = await import('../../src/tunnel-manager');

const PROBE_BODY = 'ungate-live-probe';
const START_TIMEOUT_MS = 120_000;
const REACH_TIMEOUT_MS = 90_000;

class Wait {
	static sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	static async until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (condition()) {
				return true;
			}

			await Wait.sleep(250);
		}

		return condition();
	}
}

describe('quick tunnel against real cloudflared', () => {
	const states: TunnelState[] = [];
	const logs: LogEntry[] = [];
	let origin: http.Server;
	let port: number;
	let manager: InstanceType<typeof TunnelManager>;

	beforeAll(async () => {
		expect(os.homedir()).toBe(isolatedHome);
		expect(RuntimeStateStore.getFilePath().startsWith(isolatedHome + path.sep)).toBe(true);

		origin = http.createServer((request, response) => {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end(`${PROBE_BODY} ${request.url}`);
		});

		await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
		port = (origin.address() as AddressInfo).port;

		manager = new TunnelManager(
			'live-test-window',
			() => true,
			(state) => states.push(state),
			(entry) => logs.push(entry)
		);
	});

	afterAll(async () => {
		manager.stop();
		await new Promise<void>((resolve) => origin.close(() => resolve()));
		await Wait.until(() => CloudflaredProcess.findServing(port) === null, 10_000);
		fs.rmSync(isolatedHome, { recursive: true, force: true });
	});

	it(
		'starts, publishes a trycloudflare.com URL and records it in the runtime state file',
		async () => {
			await manager.start(port);
			await Wait.until(() => ['running', 'error'].includes(manager.getState().status), START_TIMEOUT_MS);

			const state = manager.getState();

			if (state.status !== 'running') {
				const output = logs.map((entry) => entry.message).join('\n');

				throw new Error(`Tunnel ended in ${state.status} (${state.error}). cloudflared output:\n${output}`);
			}

			expect(new URL(state.url ?? '').hostname).toMatch(/^[a-z0-9-]+\.trycloudflare\.com$/);

			await Wait.until(() => RuntimeStateStore.read().tunnel.url === state.url, 5_000);
			expect(RuntimeStateStore.read().tunnel.url).toBe(state.url);
			expect(CloudflaredProcess.findServing(port)).not.toBeNull();
		},
		START_TIMEOUT_MS + 30_000
	);

	it(
		'serves the local API through the public URL',
		async () => {
			const url = manager.getState().url;

			expect(url).not.toBeNull();

			const deadline = Date.now() + REACH_TIMEOUT_MS;
			let last = 'no attempt';

			// A fresh quick-tunnel hostname takes a few seconds to resolve; asking too early
			// makes the resolver remember that it does not exist.
			await Wait.sleep(8_000);

			while (Date.now() < deadline) {
				try {
					const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
					const body = await response.text();

					last = `HTTP ${response.status} ${body.slice(0, 80)}`;

					if (response.status === 200 && body === `${PROBE_BODY} /health`) {
						return;
					}
				} catch (err) {
					const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';

					last = `${String(err)}${cause}`;
				}

				await Wait.sleep(3_000);
			}

			expect.fail(`The tunnel URL never served the local origin. Last result: ${last}`);
		},
		REACH_TIMEOUT_MS + 30_000
	);

	it('stops the cloudflared process and clears the URL', async () => {
		manager.stop();

		expect(manager.getState()).toMatchObject({ status: 'stopped', url: null });

		const exited = await Wait.until(() => CloudflaredProcess.findServing(port) === null, 10_000);

		expect(exited).toBe(true);

		await Wait.until(() => RuntimeStateStore.read().tunnel.url === null, 5_000);
		expect(RuntimeStateStore.read().tunnel.url).toBeNull();
	});
});
