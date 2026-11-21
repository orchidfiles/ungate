import { EventEmitter } from 'node:events';
import * as net from 'node:net';

import type { BridgeChild } from './cursor-bridge';

/**
 * The bridge socket of an API this window adopted rather than spawned, shaped like the spawned
 * child's IPC channel so `CursorBridge` serves both the same way. One JSON message per line.
 */
export class BridgeSocket extends EventEmitter implements BridgeChild {
	connected = true;
	private buffered = '';

	private constructor(private readonly socket: net.Socket) {
		super();
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => this.read(chunk));
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			this.connected = false;
			this.emit('disconnect');
		});
	}

	/** Connects to `path`; rejects when no API serves a bridge there. */
	static connect(path: string): Promise<BridgeSocket> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(path);
			socket.once('error', reject);
			socket.once('connect', () => {
				socket.off('error', reject);
				resolve(new BridgeSocket(socket));
			});
		});
	}

	send(message: never): boolean {
		if (!this.connected) return false;

		return this.socket.write(`${JSON.stringify(message)}\n`);
	}

	close(): void {
		this.socket.destroy();
	}

	private read(chunk: string): void {
		this.buffered += chunk;
		let newline = this.buffered.indexOf('\n');
		while (newline !== -1) {
			const line = this.buffered.slice(0, newline);
			this.buffered = this.buffered.slice(newline + 1);
			newline = this.buffered.indexOf('\n');
			if (line.trim() === '') continue;
			try {
				this.emit('message', JSON.parse(line) as unknown);
			} catch {
				// A line that is not JSON is not a bridge message; the bridge ignores it like any other.
			}
		}
	}
}
