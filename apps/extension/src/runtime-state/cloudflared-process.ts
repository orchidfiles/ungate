import * as cp from 'node:child_process';
import * as fs from 'node:fs';

import { localApiBaseUrl } from '@ungate/shared';

export interface ServingCloudflared {
	pid: number;
	command: string;
}

export class CloudflaredProcess {
	/** True when a process command is cloudflared pointed at the IPv4 API origin. */
	public static servesApiPort(command: string, port: number | null): boolean {
		if (!command.includes('cloudflared')) {
			return false;
		}

		if (port != null) {
			return command.includes(localApiBaseUrl(port));
		}

		return /http:\/\/127\.0\.0\.1:\d+/.test(command);
	}

	/**
	 * A quick tunnel already proxying the local API. `port` null matches any IPv4 origin,
	 * which is how a live tunnel is recognized after the API port has been cleared.
	 */
	public static findServing(port: number | null): ServingCloudflared | null {
		for (const candidate of this.listCommands()) {
			if (this.servesApiPort(candidate.command, port)) {
				return candidate;
			}
		}

		return null;
	}

	private static listCommands(): ServingCloudflared[] {
		if (process.platform === 'linux') {
			return this.listLinuxCommands();
		}

		return this.listPsCommands();
	}

	private static listLinuxCommands(): ServingCloudflared[] {
		let entries: string[];

		try {
			entries = fs.readdirSync('/proc');
		} catch {
			return [];
		}

		const commands: ServingCloudflared[] = [];

		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) {
				continue;
			}

			try {
				const command = fs.readFileSync(`/proc/${entry}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();

				if (command) {
					const serving: ServingCloudflared = { pid: Number(entry), command };
					commands.push(serving);
				}
			} catch {
				// The process exited between readdir and read.
			}
		}

		return commands;
	}

	private static listPsCommands(): ServingCloudflared[] {
		const listed = cp.spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });

		if (listed.status !== 0 || !listed.stdout) {
			return [];
		}

		const commands: ServingCloudflared[] = [];

		for (const line of listed.stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(.*)$/.exec(line);

			if (!match) {
				continue;
			}

			const serving: ServingCloudflared = { pid: Number(match[1]), command: match[2] };
			commands.push(serving);
		}

		return commands;
	}
}
