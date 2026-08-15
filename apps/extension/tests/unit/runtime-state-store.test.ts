import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeStateStore } from '../../src/runtime-state/runtime-state-store';

import type { RuntimeState, TunnelStatus } from '@ungate/shared/frontend';

const { runtimeMutateMock, runtimeReadMock } = vi.hoisted(() => {
	return {
		runtimeMutateMock: vi.fn<(mutator: (current: RuntimeState) => RuntimeState) => Promise<RuntimeState>>(),
		runtimeReadMock: vi.fn<() => RuntimeState>()
	};
});

vi.mock('../../src/runtime-state/file-store', () => {
	return {
		RuntimeStateFileStore: {
			read: runtimeReadMock,
			write: vi.fn(),
			mutate: runtimeMutateMock,
			getFilePath: vi.fn(() => '/tmp/runtime-state.json')
		}
	};
});

function createState(apiStatus: RuntimeState['api']['status'], lastError: string | null = null): RuntimeState {
	return {
		api: {
			pid: 91696,
			port: 47821,
			status: apiStatus,
			lastSeenAt: 0,
			lastError,
			ownerWindowId: null,
			startSuppressed: true
		},
		tunnel: {
			status: 'stopped',
			url: null,
			lastSeenAt: 0,
			lastError: null,
			ownerWindowId: null
		},
		keyFix: { enabled: false },
		clients: {},
		commands: []
	};
}

function createOrphanedTunnelState(status: TunnelStatus): RuntimeState {
	const state = createState('stopped');
	state.tunnel.status = status;
	state.tunnel.url = 'https://example.trycloudflare.com';
	state.tunnel.lastError = 'stale';
	state.tunnel.ownerWindowId = null;
	state.tunnel.lastSeenAt = 1;

	return state;
}

describe('RuntimeStateStore', () => {
	beforeEach(() => {
		runtimeMutateMock.mockReset();
		runtimeReadMock.mockReset();
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false }))
		);
	});

	it('prepareApiForBootstrap clears stale port and releases suppression', async () => {
		const initial = createState('error', '[process] health check failed');
		runtimeReadMock.mockReturnValue(initial);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(initial))));

		const next = await RuntimeStateStore.prepareApiForBootstrap();

		expect(runtimeMutateMock).toHaveBeenCalledTimes(1);
		expect(next.api.startSuppressed).toBe(false);
		expect(next.api.status).toBe('stopped');
		expect(next.api.port).toBeNull();
	});

	it('suppressApiAutoStart blocks further automatic starts in the same session', async () => {
		const initial = createState('stopped');
		initial.api.startSuppressed = false;
		runtimeReadMock.mockReturnValue(initial);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(initial))));

		await RuntimeStateStore.suppressApiAutoStart('[native] failed');

		expect(runtimeMutateMock).toHaveBeenCalledTimes(1);
		const next = runtimeMutateMock.mock.calls[0][0](structuredClone(initial));
		expect(next.api.startSuppressed).toBe(true);
		expect(next.api.status).toBe('error');
	});

	it.each(['running', 'starting', 'installing'] as const)('clears an orphaned %s tunnel', async (status: TunnelStatus) => {
		const initial = createOrphanedTunnelState(status);
		runtimeReadMock.mockReturnValue(initial);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(initial))));

		const next = await RuntimeStateStore.reconcileOrphanedTunnel();

		expect(runtimeMutateMock).toHaveBeenCalledTimes(1);
		expect(next.tunnel.status).toBe('stopped');
		expect(next.tunnel.url).toBeNull();
		expect(next.tunnel.lastError).toBeNull();
		expect(next.tunnel.ownerWindowId).toBeNull();
		expect(next.tunnel.lastSeenAt).toBeGreaterThan(initial.tunnel.lastSeenAt);
	});

	it('returns live-owned tunnel unchanged without mutate', async () => {
		const state = createOrphanedTunnelState('running');
		state.tunnel.ownerWindowId = 'window-a';
		state.clients = { 'window-a': { lastSeenAt: Date.now() } };

		const next = await RuntimeStateStore.reconcileOrphanedTunnel(state);

		expect(next).toBe(state);
		expect(runtimeMutateMock).not.toHaveBeenCalled();
	});

	it('preserves tunnel when owner becomes live before locked mutation', async () => {
		const orphaned = createOrphanedTunnelState('running');
		orphaned.tunnel.ownerWindowId = 'window-a';

		const claimed = structuredClone(orphaned);
		claimed.clients = { 'window-a': { lastSeenAt: Date.now() } };

		runtimeReadMock.mockReturnValue(orphaned);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(claimed))));

		const next = await RuntimeStateStore.reconcileOrphanedTunnel();

		expect(runtimeMutateMock).toHaveBeenCalledTimes(1);
		expect(next.tunnel.status).toBe('running');
		expect(next.tunnel.url).toBe(orphaned.tunnel.url);
		expect(next.tunnel.ownerWindowId).toBe('window-a');
	});
});
