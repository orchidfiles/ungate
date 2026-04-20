import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_NODE_COMMAND = 'node';

interface RuntimeInfo {
	abi: string;
	platform: string;
	arch: string;
}

export class NodeResolver {
	static resolve(overridePath?: string): string {
		if (overridePath) {
			return overridePath;
		}

		const candidates = this.getCandidates();

		for (const candidate of candidates) {
			if (this.isUsable(candidate)) {
				return candidate;
			}
		}

		return DEFAULT_NODE_COMMAND;
	}

	static inspect(runtime: string): RuntimeInfo {
		const result = cp.spawnSync(
			runtime,
			['-p', 'JSON.stringify({ abi: process.versions.modules, platform: process.platform, arch: process.arch })'],
			{ encoding: 'utf8' }
		);

		if (result.error) {
			throw result.error;
		}

		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || `Failed to inspect runtime: ${runtime}`);
		}

		return JSON.parse(result.stdout.trim()) as RuntimeInfo;
	}

	private static getCandidates(): string[] {
		const candidates: string[] = [];
		const seen = new Set<string>();
		const homeDir = os.homedir();
		const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';

		this.push(candidates, seen, DEFAULT_NODE_COMMAND);
		this.push(candidates, seen, process.env.UNGATE_NODE_BIN);

		if (process.platform === 'darwin') {
			this.push(candidates, seen, '/opt/homebrew/bin/node');
			this.push(candidates, seen, '/usr/local/bin/node');
			this.push(candidates, seen, '/usr/bin/node');
		}

		if (process.platform === 'linux') {
			this.push(candidates, seen, '/usr/local/bin/node');
			this.push(candidates, seen, '/usr/bin/node');
			this.push(candidates, seen, '/bin/node');
			this.push(candidates, seen, '/snap/bin/node');
		}

		if (process.platform === 'win32') {
			this.push(candidates, seen, process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, binaryName) : undefined);
			this.push(candidates, seen, process.env.NVM_HOME ? path.join(process.env.NVM_HOME, binaryName) : undefined);
			this.push(
				candidates,
				seen,
				process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', binaryName) : undefined
			);
			this.push(
				candidates,
				seen,
				process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', binaryName) : undefined
			);
			this.push(
				candidates,
				seen,
				process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', binaryName) : undefined
			);
			this.pushFromDir(candidates, seen, process.env.NVM_HOME ?? '', binaryName);
		}

		this.push(candidates, seen, path.join(homeDir, '.volta', 'bin', binaryName));
		this.push(candidates, seen, path.join(homeDir, '.asdf', 'shims', binaryName));
		this.pushFromDir(candidates, seen, path.join(homeDir, '.nvm', 'versions', 'node'), binaryName);

		return candidates;
	}

	private static push(candidates: string[], seen: Set<string>, candidate: string | undefined): void {
		if (!candidate) {
			return;
		}

		if (seen.has(candidate)) {
			return;
		}

		seen.add(candidate);
		candidates.push(candidate);
	}

	private static pushFromDir(candidates: string[], seen: Set<string>, dir: string, binaryName: string): void {
		if (!dir || !fs.existsSync(dir)) {
			return;
		}

		const entries = fs.readdirSync(dir).sort().reverse();

		for (const entry of entries) {
			this.push(candidates, seen, path.join(dir, entry, 'bin', binaryName));
		}
	}

	private static isUsable(candidate: string): boolean {
		const result = cp.spawnSync(candidate, ['-v'], { encoding: 'utf8' });

		return !result.error && result.status === 0;
	}
}
