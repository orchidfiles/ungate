import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { cursorBridgeSocketName } from '@ungate/shared';

/** How the API reaches the extension host that owns the Cursor session. */
export interface BridgeTransport {
	/** An extension is on the other end right now. */
	isConnected(): boolean;
	/** Throws when nothing is connected. */
	send(message: unknown): void;
	on(event: 'message', listener: (message: unknown) => void): unknown;
	/** The extension went away; anything it was serving will not finish. */
	on(event: 'disconnect', listener: () => void): unknown;
}

/** The private IPC channel of an API the extension spawned itself. */
export class ProcessBridgeTransport extends EventEmitter implements BridgeTransport {
	constructor(private readonly child: NodeJS.Process = process) {
		super();
		child.on('message', (message) => this.emit('message', message));
		child.on('disconnect', () => this.emit('disconnect'));
	}

	isConnected(): boolean {
		return typeof this.child.send === 'function' && this.child.connected;
	}

	send(message: unknown): void {
		if (!this.child.send) throw new Error('No IPC channel');
		this.child.send(message as never);
	}
}

/**
 * A Unix socket for an API no extension spawned, such as a systemd service. The leader window
 * connects when it adopts the API; a newer connection replaces an older one. Messages are one
 * JSON document per line. The socket is created owner-only.
 */
export class SocketBridgeTransport extends EventEmitter implements BridgeTransport {
	private server: Server | null = null;
	private path: string | null = null;
	private socket: Socket | null = null;

	isConnected(): boolean {
		return this.socket !== null;
	}

	send(message: unknown): void {
		if (!this.socket) throw new Error('No extension is connected to the Cursor bridge');
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	/** Listens at `path`, replacing a socket file a previous run left behind. */
	async listen(path: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await rm(path, { force: true });

		const server = createServer((socket) => this.adopt(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(path, () => {
				server.off('error', reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		this.server = server;
		this.path = path;
	}

	/** Stops listening and removes the socket file, so no stale `cursor-bridge-<port>.sock` outlives the API. */
	async close(): Promise<void> {
		this.socket?.destroy();
		const server = this.server;
		this.server = null;
		if (server) await new Promise((resolve) => server.close(resolve));
		this.removeSocketFile();
	}

	/** Synchronous, for `process.on('exit')` where nothing async runs. */
	removeSocketFile(): void {
		const path = this.path;
		this.path = null;
		if (path) rmSync(path, { force: true });
	}

	private adopt(socket: Socket): void {
		// The new extension cannot answer what the previous one was serving, so those calls end
		// as disconnected now, before any call can reach the new socket.
		const previous = this.socket;
		if (previous) {
			this.socket = null;
			previous.destroy();
			this.emit('disconnect');
		}
		this.socket = socket;

		let buffered = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffered += chunk;
			let newline = buffered.indexOf('\n');
			while (newline !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf('\n');
				if (line.trim() === '') continue;
				try {
					this.emit('message', JSON.parse(line) as unknown);
				} catch {
					// A line that is not JSON is not a bridge message; the protocol ignores it like any other.
				}
			}
		});
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.emit('disconnect');
		});
	}
}

/** Where an API on `port` serves the bridge socket; the extension computes the same path. */
export function cursorBridgeSocketPath(port: number): string {
	return join(homedir(), '.ungate', cursorBridgeSocketName(port));
}
