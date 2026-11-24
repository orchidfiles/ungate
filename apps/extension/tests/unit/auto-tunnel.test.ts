import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		state: null as RuntimeState | null,
		clipboardWriteMock: vi.fn(() => Promise.resolve()),
		showInfoMock: vi.fn(() => Promise.resolve(undefined)),
		executeCommandMock: vi.fn(() => Promise.resolve())
	};
});

vi.mock('vscode', () => {
	return {
		env: { clipboard: { writeText: mocks.clipboardWriteMock } },
		window: { showInformationMessage: mocks.showInfoMock },
		commands: { executeCommand: mocks.executeCommandMock }
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: () => mocks.state,
			mutate: (mutator: (current: RuntimeState) => RuntimeState) => {
				mocks.state = mutator(structuredClone(mocks.state!));

				return Promise.resolve(mocks.state);
			}
		}
	};
});

import { AutoTunnel } from '../../src/auto-tunnel';
import { RuntimeStateNormalizer } from '../../src/runtime-state/normalizer';

import { TestHelper } from './helpers/test-helper';

import type { RuntimeState } from '@ungate/shared/frontend';

function createAutoTunnel() {
	const deps = {
		startTunnel: vi.fn(),
		ensureKeyEnabled: vi.fn(() => Promise.resolve()),
		onStateChange: vi.fn(),
		log: vi.fn()
	};

	return { autoTunnel: new AutoTunnel(deps), deps };
}

function enabledState(): RuntimeState {
	const state = TestHelper.createRuntimeState(['window-a']);
	state.autoTunnel.enabled = true;

	return state;
}

describe('RuntimeStateNormalizer autoTunnel', () => {
	it('defaults autoTunnel when an older state file has none', () => {
		const legacy = TestHelper.createRuntimeState(['window-a']) as Partial<RuntimeState>;
		delete legacy.autoTunnel;
		legacy.keyFix = { enabled: true };

		const next = RuntimeStateNormalizer.normalize(legacy);

		expect(next.autoTunnel).toEqual({ enabled: false, lastAppliedUrl: null });
		expect(next.keyFix.enabled).toBe(true);
	});

	it('keeps a stored autoTunnel', () => {
		const stored = enabledState();
		stored.autoTunnel.lastAppliedUrl = 'https://a.trycloudflare.com';

		const next = RuntimeStateNormalizer.normalize(stored);

		expect(next.autoTunnel).toEqual({ enabled: true, lastAppliedUrl: 'https://a.trycloudflare.com' });
	});
});

describe('AutoTunnel.reconcile', () => {
	beforeEach(() => {
		mocks.state = enabledState();
		mocks.clipboardWriteMock.mockClear();
		mocks.showInfoMock.mockClear();
	});

	it('starts the tunnel when enabled, owned, API running and tunnel stopped', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		await autoTunnel.reconcile(enabledState(), { port: null, ownsTunnel: true });

		expect(deps.startTunnel).toHaveBeenCalledWith(4783);
		expect(deps.onStateChange).toHaveBeenCalledWith(true);
	});

	it('does nothing when the toggle is off', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		await autoTunnel.reconcile(TestHelper.createRuntimeState(['window-a']), { port: 4783, ownsTunnel: true });

		expect(deps.startTunnel).not.toHaveBeenCalled();
	});

	it('does nothing in a window that does not own the tunnel', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		await autoTunnel.reconcile(enabledState(), { port: 4783, ownsTunnel: false });

		expect(deps.startTunnel).not.toHaveBeenCalled();
	});

	it('waits for the API to run', async () => {
		const { autoTunnel, deps } = createAutoTunnel();
		const state = enabledState();
		state.api.status = 'starting';

		await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });

		expect(deps.startTunnel).not.toHaveBeenCalled();
	});

	it('does not start a tunnel that is already starting or failed', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		for (const status of ['starting', 'installing', 'error'] as const) {
			const state = enabledState();
			state.tunnel.status = status;
			await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });
		}

		expect(deps.startTunnel).not.toHaveBeenCalled();
	});

	it('starts at most once per API process, even after the tunnel stops again', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		await autoTunnel.reconcile(enabledState(), { port: 4783, ownsTunnel: true });
		await autoTunnel.reconcile(enabledState(), { port: 4783, ownsTunnel: true });

		expect(deps.startTunnel).toHaveBeenCalledTimes(1);

		const restarted = enabledState();
		restarted.api.pid = 5678;
		await autoTunnel.reconcile(restarted, { port: 4783, ownsTunnel: true });

		expect(deps.startTunnel).toHaveBeenCalledTimes(2);
	});

	it('announces a running tunnel URL it has not announced yet', async () => {
		const { autoTunnel } = createAutoTunnel();
		const state = enabledState();
		state.tunnel.status = 'running';
		state.tunnel.url = 'https://a.trycloudflare.com';

		await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });

		expect(mocks.clipboardWriteMock).toHaveBeenCalledWith('https://a.trycloudflare.com/v1');
	});
});

describe('AutoTunnel with a flagged tunnel hostname', () => {
	const flaggedUrl = 'https://acre-idiot-case.ngrok-free.dev';

	function flaggedState(): RuntimeState {
		const state = enabledState();
		state.tunnelProvider = 'ngrok';
		state.tunnel.status = 'running';
		state.tunnel.url = flaggedUrl;
		state.tunnel.warning = 'offensive-hostname';

		return state;
	}

	beforeEach(() => {
		mocks.state = flaggedState();
		mocks.clipboardWriteMock.mockClear();
		mocks.showInfoMock.mockClear();
	});

	it('does not copy or announce it on reconcile', async () => {
		const { autoTunnel, deps } = createAutoTunnel();

		await autoTunnel.reconcile(flaggedState(), { port: 4783, ownsTunnel: true });

		expect(mocks.clipboardWriteMock).not.toHaveBeenCalled();
		expect(mocks.showInfoMock).not.toHaveBeenCalled();
		expect(deps.ensureKeyEnabled).not.toHaveBeenCalled();
		expect(deps.startTunnel).not.toHaveBeenCalled();
		expect(JSON.stringify(deps.log.mock.calls)).not.toContain('idiot');
		expect(mocks.state?.autoTunnel.lastAppliedUrl).toBeNull();
	});

	it('does nothing for a flagged tunnel that carries no URL', async () => {
		const { autoTunnel, deps } = createAutoTunnel();
		const state = flaggedState();
		state.tunnel.url = null;

		await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });

		expect(mocks.clipboardWriteMock).not.toHaveBeenCalled();
		expect(mocks.showInfoMock).not.toHaveBeenCalled();
		expect(deps.startTunnel).not.toHaveBeenCalled();
	});

	it('announces again once the tunnel has an unflagged URL', async () => {
		const { autoTunnel } = createAutoTunnel();
		const state = flaggedState();
		await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });

		state.tunnel.url = 'https://api.example.com';
		state.tunnel.warning = null;
		mocks.state = structuredClone(state);
		await autoTunnel.reconcile(state, { port: 4783, ownsTunnel: true });

		expect(mocks.clipboardWriteMock).toHaveBeenCalledWith('https://api.example.com/v1');
	});
});

describe('RuntimeStateNormalizer tunnel warning', () => {
	it('defaults the warning when an older state file has none', () => {
		const legacy = TestHelper.createRuntimeState(['window-a']);
		delete (legacy.tunnel as Partial<RuntimeState['tunnel']>).warning;

		expect(RuntimeStateNormalizer.normalize(legacy).tunnel.warning).toBeNull();
	});

	it('keeps a stored warning', () => {
		const stored = TestHelper.createRuntimeState(['window-a']);
		stored.tunnel.warning = 'offensive-hostname';

		expect(RuntimeStateNormalizer.normalize(stored).tunnel.warning).toBe('offensive-hostname');
	});
});

describe('AutoTunnel.onTunnelUrl', () => {
	beforeEach(() => {
		mocks.state = enabledState();
		mocks.clipboardWriteMock.mockClear();
		mocks.showInfoMock.mockClear();
	});

	async function enable(autoTunnel: AutoTunnel): Promise<void> {
		await autoTunnel.reconcile(enabledState(), { port: 4783, ownsTunnel: false });
	}

	it('copies the URL, enables the key and notifies once per URL', async () => {
		const { autoTunnel, deps } = createAutoTunnel();
		await enable(autoTunnel);

		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');
		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');

		expect(mocks.clipboardWriteMock).toHaveBeenCalledTimes(1);
		expect(mocks.clipboardWriteMock).toHaveBeenCalledWith('https://a.trycloudflare.com/v1');
		expect(deps.ensureKeyEnabled).toHaveBeenCalledTimes(1);
		expect(mocks.showInfoMock).toHaveBeenCalledTimes(1);
		expect(mocks.state?.autoTunnel.lastAppliedUrl).toBe('https://a.trycloudflare.com');

		await autoTunnel.onTunnelUrl('https://b.trycloudflare.com');

		expect(mocks.showInfoMock).toHaveBeenCalledTimes(2);
	});

	it('skips a URL another window already announced', async () => {
		const { autoTunnel } = createAutoTunnel();
		await enable(autoTunnel);
		mocks.state!.autoTunnel.lastAppliedUrl = 'https://a.trycloudflare.com';

		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');

		expect(mocks.showInfoMock).not.toHaveBeenCalled();
	});

	it('does nothing while the toggle is off', async () => {
		const { autoTunnel } = createAutoTunnel();

		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');

		expect(mocks.clipboardWriteMock).not.toHaveBeenCalled();
	});

	it('re-announces the current URL after the user turns the toggle back on', async () => {
		const { autoTunnel } = createAutoTunnel();
		await enable(autoTunnel);
		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');

		await autoTunnel.setEnabledByUser(false);
		await autoTunnel.setEnabledByUser(true);
		await autoTunnel.onTunnelUrl('https://a.trycloudflare.com');

		expect(mocks.showInfoMock).toHaveBeenCalledTimes(2);
	});
});
