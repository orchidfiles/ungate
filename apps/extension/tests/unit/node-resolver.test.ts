import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const readdirSyncMock = vi.fn();

vi.mock('node:child_process', () => {
	return {
		spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
		spawn: vi.fn()
	};
});

vi.mock('node:fs', () => {
	return {
		existsSync: (...args: unknown[]) => existsSyncMock(...args),
		readdirSync: (...args: unknown[]) => readdirSyncMock(...args)
	};
});

import { NodeResolver } from '../../src/utils/node-resolver';

describe('NodeResolver', () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		spawnSyncMock.mockReset();
		existsSyncMock.mockReset();
		readdirSyncMock.mockReset();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
	});

	it('returns a supported override path when UNGATE_NODE_BIN is provided via resolve argument', () => {
		spawnSyncMock.mockReturnValue({
			error: undefined,
			status: 0,
			stdout: '{"abi":"137","platform":"win32","arch":"x64"}',
			stderr: '',
			pid: 1,
			output: [null, '{"abi":"137","platform":"win32","arch":"x64"}', ''],
			signal: null
		});

		expect(NodeResolver.resolve('C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\Program Files\\nodejs\\node.exe');
	});

	it('prefers the first usable Windows candidate', () => {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
		process.env.ProgramFiles = 'C:\\Program Files';

		const programFilesNode = path.join(process.env.ProgramFiles, 'nodejs', 'node.exe');

		spawnSyncMock.mockImplementation((command) => {
			if (command === 'node') {
				return { error: new Error('ENOENT'), status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
			}

			if (command === programFilesNode) {
				return {
					error: undefined,
					status: 0,
					stdout: '{"abi":"137","platform":"win32","arch":"x64"}',
					stderr: '',
					pid: 1,
					output: [null, '{"abi":"137","platform":"win32","arch":"x64"}', ''],
					signal: null
				};
			}

			return { error: new Error('ENOENT'), status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
		});

		existsSyncMock.mockImplementation((target) => {
			return String(target).endsWith('node.exe');
		});

		expect(NodeResolver.resolve()).toBe(programFilesNode);
	});
	it('skips an unsupported active Node and finds a supported asdf installation', () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		const asdfRoot = path.join(os.homedir(), '.asdf', 'installs', 'nodejs');
		const supportedNode = path.join(asdfRoot, '24.16.0', 'bin', 'node');

		existsSyncMock.mockImplementation((target) => String(target) === asdfRoot);
		readdirSyncMock.mockImplementation((target) => (String(target) === asdfRoot ? ['23.9.0', '24.16.0'] : []));
		spawnSyncMock.mockImplementation((command) => {
			if (command === 'node') {
				return {
					error: undefined,
					status: 0,
					stdout: '{"abi":"131","platform":"darwin","arch":"arm64"}',
					stderr: '',
					pid: 1,
					output: [null, '{"abi":"131","platform":"darwin","arch":"arm64"}', ''],
					signal: null
				};
			}

			if (command === supportedNode) {
				return {
					error: undefined,
					status: 0,
					stdout: '{"abi":"137","platform":"darwin","arch":"arm64"}',
					stderr: '',
					pid: 2,
					output: [null, '{"abi":"137","platform":"darwin","arch":"arm64"}', ''],
					signal: null
				};
			}

			return { error: new Error('ENOENT'), status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
		});

		expect(NodeResolver.resolve()).toBe(supportedNode);
	});

	it('rejects an unsupported explicit override', () => {
		spawnSyncMock.mockReturnValue({
			error: undefined,
			status: 0,
			stdout: '{"abi":"131","platform":"darwin","arch":"arm64"}',
			stderr: '',
			pid: 1,
			output: [null, '{"abi":"131","platform":"darwin","arch":"arm64"}', ''],
			signal: null
		});

		expect(() => NodeResolver.resolve('/custom/node')).toThrow('must point to Node 22, 24, 25 or 26');
	});

	it('inspect returns abi platform and arch from runtime output', () => {
		spawnSyncMock.mockReturnValue({
			error: undefined,
			status: 0,
			stdout: '{"abi":"137","platform":"win32","arch":"x64"}',
			stderr: '',
			pid: 1,
			output: [null, '{"abi":"137","platform":"win32","arch":"x64"}', ''],
			signal: null
		});

		expect(NodeResolver.inspect('C:\\Program Files\\nodejs\\node.exe')).toEqual({
			abi: '137',
			platform: 'win32',
			arch: 'x64'
		});
	});
});
