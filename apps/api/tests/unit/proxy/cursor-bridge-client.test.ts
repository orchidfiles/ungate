import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CursorBridgeClient } from 'src/proxy/cursor-bridge-client';
import { SocketBridgeTransport, type BridgeTransport } from 'src/proxy/cursor-bridge-transport';

import type { CursorBridgeEventBody } from '@ungate/shared';

/** In-memory transport: `reply` plays the extension. */
class FakeTransport extends EventEmitter implements BridgeTransport {
	readonly sent: Record<string, unknown>[] = [];
	connected = true;

	constructor(private readonly reply: (message: { id: string; kind: string }, emit: (event: object) => void) => void = () => {}) {
		super();
	}

	isConnected(): boolean {
		return this.connected;
	}

	send(message: unknown): void {
		this.sent.push(message as Record<string, unknown>);
		queueMicrotask(() =>
			this.reply(message as { id: string; kind: string }, (event) =>
				this.emit('message', { channel: 'ungate.cursor-bridge', ...event })
			)
		);
	}
}

async function collect(stream: AsyncGenerator<CursorBridgeEventBody>, onEvent?: (event: CursorBridgeEventBody) => void) {
	const events: CursorBridgeEventBody[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent?.(event);
	}

	return events;
}

const REQUEST = { modelId: 'grok', messages: [], tools: [] };

describe('CursorBridgeClient', () => {
	it('reports unavailable while no extension is connected', async () => {
		const transport = new FakeTransport();
		transport.connected = false;
		const client = new CursorBridgeClient(transport);

		expect(await client.status()).toMatchObject({ available: false, reason: 'no_bridge' });
		expect(await collect(client.invoke(REQUEST))).toEqual([
			{ kind: 'end', error: expect.objectContaining({ kind: 'unavailable' }) }
		]);
		expect(transport.sent).toEqual([]);
	});

	it('correlates events by id and sends cancel on abort', async () => {
		const transport = new FakeTransport(({ id, kind }, emit) => {
			if (kind !== 'invoke') return;
			emit({ id: 'other', kind: 'text', text: 'not mine' });
			emit({ id, kind: 'ready', resolvedModel: 'grok' });
			emit({ id, kind: 'text', text: 'hello' });
		});
		const client = new CursorBridgeClient(transport);
		const controller = new AbortController();

		const events = await collect(client.invoke(REQUEST, controller.signal), (event) => {
			if (event.kind === 'text') controller.abort();
		});

		expect(events.map((event) => event.kind)).toEqual(['ready', 'text', 'end']);
		expect(transport.sent.map((message) => message.kind)).toEqual(['invoke', 'cancel']);
		expect(JSON.stringify(transport.sent)).not.toMatch(/token|authorization|checksum/i);
	});

	it('ends an invocation in flight when the extension disconnects', async () => {
		const transport = new FakeTransport(({ id, kind }, emit) => {
			if (kind === 'invoke') emit({ id, kind: 'ready', resolvedModel: 'grok' });
		});
		const client = new CursorBridgeClient(transport);

		const events = await collect(client.invoke(REQUEST), (event) => {
			if (event.kind === 'ready') {
				transport.connected = false;
				transport.emit('disconnect');
			}
		});

		expect(events).toEqual([
			{ kind: 'ready', resolvedModel: 'grok' },
			{ kind: 'end', error: { kind: 'unavailable', message: 'Cursor bridge is disconnected' } }
		]);
	});
});

describe('SocketBridgeTransport', () => {
	let dir: string;
	let transport: SocketBridgeTransport;

	afterEach(async () => {
		await transport.close();
		await rm(dir, { recursive: true, force: true });
	});

	async function listening(): Promise<string> {
		dir = await mkdtemp(join(tmpdir(), 'ungate-bridge-'));
		const path = join(dir, 'nested', 'bridge.sock');
		transport = new SocketBridgeTransport();
		await transport.listen(path);

		return path;
	}

	/** An extension stand-in that answers `status` and streams two events for `invoke`. */
	function extension(path: string): Promise<Socket> {
		return new Promise((resolve) => {
			const socket = createConnection(path, () => resolve(socket));
			let buffered = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffered += chunk;
				const lines = buffered.split('\n');
				buffered = lines.pop() ?? '';
				for (const line of lines) {
					const { id, kind } = JSON.parse(line) as { id: string; kind: string };
					const send = (event: object) => socket.write(`${JSON.stringify({ channel: 'ungate.cursor-bridge', id, ...event })}\n`);
					if (kind === 'status')
						send({ kind: 'status', status: { available: true, connected: true, reason: 'ok', membershipType: 'pro' } });
					if (kind === 'invoke') {
						send({ kind: 'text', text: 'hi' });
						send({ kind: 'end', error: null });
					}
				}
			});
		});
	}

	async function until(predicate: () => boolean): Promise<void> {
		for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(predicate()).toBe(true);
	}

	it('serves the bridge to a connected extension over an owner-only socket', async () => {
		const path = await listening();
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		const client = new CursorBridgeClient(transport);
		expect(client.isAvailable()).toBe(false);

		const socket = await extension(path);
		await until(() => client.isAvailable());

		expect(await client.status()).toMatchObject({ connected: true, membershipType: 'pro' });
		expect(await collect(client.invoke(REQUEST))).toEqual([
			{ kind: 'text', text: 'hi' },
			{ kind: 'end', error: null }
		]);

		socket.destroy();
		await until(() => !client.isAvailable());
	});

	it('hands the bridge to the newest connection', async () => {
		const path = await listening();
		const client = new CursorBridgeClient(transport);

		const first = await extension(path);
		await until(() => client.isAvailable());
		const closed = new Promise((resolve) => first.once('close', resolve));
		await extension(path);
		await closed;

		expect(client.isAvailable()).toBe(true);
		expect(await client.status()).toMatchObject({ connected: true });
	});

	it('ends the calls the previous connection was serving when a new one takes over', async () => {
		const path = await listening();
		const client = new CursorBridgeClient(transport);

		// An extension that takes calls and never answers them.
		const silent = await new Promise<Socket>((resolve) => {
			const socket = createConnection(path, () => resolve(socket));
		});
		await until(() => client.isAvailable());
		const pending = collect(client.invoke(REQUEST));
		await new Promise((resolve) => setTimeout(resolve, 20));

		await extension(path);
		const events = await pending;
		expect(events.at(-1)).toMatchObject({ kind: 'end', error: { kind: 'unavailable' } });
		expect(client.isAvailable()).toBe(true);
		silent.destroy();
	});

	it('replaces a socket file a previous run left behind', async () => {
		const path = await listening();
		await transport.close();
		await writeFile(path, '');

		const again = new SocketBridgeTransport();
		await again.listen(path);
		transport = again;

		const client = new CursorBridgeClient(transport);
		await extension(path);
		await until(() => client.isAvailable());
	});

	it('removes its socket file on close, so a stopped API leaves nothing behind', async () => {
		const path = await listening();
		await extension(path);
		expect(existsSync(path)).toBe(true);

		await transport.close();

		expect(existsSync(path)).toBe(false);
	});

	it('removes its socket file synchronously for an exiting process', async () => {
		const path = await listening();

		transport.removeSocketFile();

		expect(existsSync(path)).toBe(false);
	});
});
