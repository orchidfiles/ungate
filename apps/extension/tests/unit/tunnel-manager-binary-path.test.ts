import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		existsSyncMock: vi.fn(),
		renameSyncMock: vi.fn(),
		useMock: vi.fn(),
		binExport: '/dev/cloudflared-package/bin/cloudflared'
	};
});

vi.mock('cloudflared', () => {
	return {
		bin: mocks.binExport,
		use: mocks.useMock,
		Tunnel: {
			quick: vi.fn(() => ({
				on: vi.fn(),
				stop: vi.fn()
			}))
		}
	};
});

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();

	return {
		...original,
		existsSync: mocks.existsSyncMock,
		renameSync: mocks.renameSyncMock
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			mutate: vi.fn((mutator: (state: unknown) => unknown) => Promise.resolve(mutator({ tunnel: {} }))),
			read: vi.fn(() => ({ clients: {} })),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

import { TunnelManager } from '../../src/tunnel-manager';
import { CloudflaredInstaller } from '../../src/utils/cloudflared-installer';

function createManager(): TunnelManager {
	return new TunnelManager(
		'window-a',
		() => true,
		() => {},
		() => {}
	);
}

describe('TunnelManager cloudflared binary path', () => {
	const binDir = path.join(os.homedir(), '.ungate', 'bin');
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('installs cloudflared.exe from the pinned artifact on win32', async () => {
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

		const expectedPath = path.join(binDir, 'cloudflared.exe');

		mocks.existsSyncMock.mockReturnValue(false);
		vi.spyOn(CloudflaredInstaller, 'isPinnedInstall').mockReturnValue(false);

		const installSpy = vi.spyOn(CloudflaredInstaller, 'install').mockResolvedValue(expectedPath);

		await createManager().start(47821);

		expect(installSpy).toHaveBeenCalledWith(expectedPath);
		expect(mocks.useMock).toHaveBeenCalledWith(expectedPath);
	});

	it('reuses a managed binary that carries the pinned checksum stamp', async () => {
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

		const expectedPath = path.join(binDir, 'cloudflared.exe');

		mocks.existsSyncMock.mockReturnValue(false);
		vi.spyOn(CloudflaredInstaller, 'isPinnedInstall').mockReturnValue(true);

		const installSpy = vi.spyOn(CloudflaredInstaller, 'install');

		await createManager().start(47821);

		expect(mocks.useMock).toHaveBeenCalledWith(expectedPath);
		expect(installSpy).not.toHaveBeenCalled();
	});

	it('renames a legacy Windows install without .exe extension, then replaces it because it is unverified', async () => {
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

		const legacyPath = path.join(binDir, 'cloudflared');
		const expectedPath = path.join(binDir, 'cloudflared.exe');

		mocks.existsSyncMock.mockImplementation((target) => String(target) === legacyPath);
		vi.spyOn(CloudflaredInstaller, 'isPinnedInstall').mockReturnValue(false);

		const installSpy = vi.spyOn(CloudflaredInstaller, 'install').mockResolvedValue(expectedPath);

		await createManager().start(47821);

		expect(mocks.renameSyncMock).toHaveBeenCalledWith(legacyPath, expectedPath);
		expect(installSpy).toHaveBeenCalledWith(expectedPath);
		expect(mocks.useMock).toHaveBeenCalledWith(expectedPath);
	});

	it('surfaces a failed verification as a tunnel error instead of starting cloudflared', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

		mocks.existsSyncMock.mockReturnValue(false);
		vi.spyOn(CloudflaredInstaller, 'isPinnedInstall').mockReturnValue(false);
		vi.spyOn(CloudflaredInstaller, 'install').mockRejectedValue(new Error('Checksum mismatch for cloudflared-linux-amd64'));

		const manager = createManager();

		await manager.start(47821);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Install failed: Checksum mismatch for cloudflared-linux-amd64'
		});
		expect(mocks.useMock).not.toHaveBeenCalled();
	});
});
