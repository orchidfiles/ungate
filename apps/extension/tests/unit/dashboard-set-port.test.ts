import * as fs from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

const createWebviewPanelMock = vi.fn();
const executeCommandMock = vi.fn();
const getConfigurationMock = vi.fn();
const configurationUpdateMock = vi.fn();
const configurationGetMock = vi.fn(() => undefined as string | undefined);
const globalStateGetMock = vi.fn(() => undefined as string | undefined);
const globalStateUpdateMock = vi.fn();
const fileUriMock = vi.fn((value: string) => {
	return { fsPath: value, toString: () => value };
});
const sharedLogs = {
	api: [] as { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }[],
	tunnel: [] as { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }[]
};

vi.mock('node:fs', () => {
	return {
		readFileSync: vi.fn(() => '<html><head></head><body></body></html>')
	};
});

vi.mock('../../src/runtime-state/shared-log-store', () => {
	return {
		SharedLogStore: {
			append(source: 'api' | 'tunnel', entry: { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }) {
				sharedLogs[source].push(entry);
			},
			readAll(source: 'api' | 'tunnel') {
				return [...sharedLogs[source]];
			},
			readSince(source: 'api' | 'tunnel', byteOffset: number) {
				const entries = sharedLogs[source].slice(byteOffset);

				return { entries, nextOffset: sharedLogs[source].length };
			},
			getFileSize() {
				return Math.max(sharedLogs.api.length, sharedLogs.tunnel.length);
			},
			clear(source: 'api' | 'tunnel') {
				sharedLogs[source] = [];
			}
		}
	};
});

vi.mock('vscode', () => {
	class Disposable {
		dispose(): void {}
	}

	return {
		window: {
			createWebviewPanel: createWebviewPanelMock
		},
		workspace: {
			getConfiguration: getConfigurationMock
		},
		commands: {
			executeCommand: executeCommandMock
		},
		ViewColumn: {
			One: 1
		},
		ConfigurationTarget: {
			Global: 1
		},
		Uri: {
			file: fileUriMock
		},
		ExtensionMode: {
			Development: 1,
			Production: 2
		},
		MarkdownString: TestHelper.createMarkdownStringClass(),
		Disposable
	};
});

let Dashboard: typeof import('../../src/dashboard').Dashboard;

function createPanel() {
	return TestHelper.createDashboardPanel();
}

function createView() {
	return {
		webview: {
			html: '',
			options: {} as Record<string, unknown>,
			postMessage: vi.fn(),
			asWebviewUri: vi.fn((value) => value),
			onDidReceiveMessage: vi.fn()
		},
		onDidChangeVisibility: vi.fn(),
		onDidDispose: vi.fn(),
		visible: true,
		show: vi.fn()
	};
}

function createExtensionContext(extensionMode = 1) {
	return {
		extensionMode,
		extensionPath: '/tmp/ungate-extension',
		globalState: {
			get: globalStateGetMock,
			update: globalStateUpdateMock
		}
	};
}

function createDashboard() {
	return new Dashboard(createExtensionContext() as never, () => {});
}

describe('Dashboard.setPort', () => {
	beforeAll(async () => {
		const module = await import('../../src/dashboard');
		Dashboard = module.Dashboard;
	});

	beforeEach(() => {
		createWebviewPanelMock.mockReset();
		executeCommandMock.mockReset();
		getConfigurationMock.mockReset();
		configurationUpdateMock.mockReset();
		configurationUpdateMock.mockResolvedValue(undefined);
		configurationGetMock.mockReset();
		configurationGetMock.mockReturnValue(undefined);
		globalStateGetMock.mockReset();
		globalStateGetMock.mockReturnValue(undefined);
		globalStateUpdateMock.mockReset();
		globalStateUpdateMock.mockResolvedValue(undefined);
		getConfigurationMock.mockReturnValue({
			get: configurationGetMock,
			update: configurationUpdateMock
		});
		fileUriMock.mockClear();
		sharedLogs.api.length = 0;
		sharedLogs.tunnel.length = 0;
	});

	it('drops the crossorigin attribute so the panel can load its script', () => {
		vi.mocked(fs.readFileSync).mockReturnValueOnce(
			'<html><head><script type="module" crossorigin src="/assets/index.js"></script><link rel="stylesheet" crossorigin href="/assets/index.css"></head><body></body></html>'
		);
		const view = createView();
		const dashboard = new Dashboard(createExtensionContext(2) as never, () => {});

		dashboard.resolveWebviewView(view as never);

		expect(view.webview.html).not.toContain('crossorigin');
		expect(view.webview.html).toContain('src="/tmp/ungate-extension/bundled/web/dist/assets/index.js"');
	});

	it('opens an editor tab by default', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();

		dashboard.show();

		expect(createWebviewPanelMock).toHaveBeenCalledWith(
			'ungate',
			'Ungate',
			1,
			expect.objectContaining({
				enableScripts: true,
				portMapping: []
			})
		);
		expect(executeCommandMock).not.toHaveBeenCalled();
	});

	it('focuses the panel view when dashboardPlacement is panel', () => {
		globalStateGetMock.mockReturnValue('panel');
		const dashboard = createDashboard();

		dashboard.show();

		expect(executeCommandMock).toHaveBeenCalledWith('ungate.dashboard.focus');
		expect(createWebviewPanelMock).not.toHaveBeenCalled();
	});

	it('reads a legacy Cursor setting when globalState is empty', () => {
		configurationGetMock.mockReturnValue('panel');
		const dashboard = createDashboard();

		dashboard.show();

		expect(executeCommandMock).toHaveBeenCalledWith('ungate.dashboard.focus');
	});

	it('persists dashboard placement in globalState', async () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();
		dashboard.show();
		panel.webview.postMessage.mockClear();

		await dashboard.setPlacement('panel');

		expect(globalStateUpdateMock).toHaveBeenCalledWith('dashboardPlacement', 'panel');
		expect(configurationUpdateMock).toHaveBeenCalledWith('dashboardPlacement', undefined, 1);
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'dashboard-placement-state', placement: 'panel' });
	});

	it('does not rebuild the webview when the port did not change', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();
		dashboard.show();

		const rebuildSpy = vi.spyOn(dashboard as unknown as { rebuildHtml(): void }, 'rebuildHtml');

		dashboard.setPort(4783);
		rebuildSpy.mockClear();
		panel.webview.postMessage.mockClear();

		dashboard.setPort(4783);

		expect(rebuildSpy).not.toHaveBeenCalled();
		expect(panel.webview.postMessage).not.toHaveBeenCalled();
	});

	it('sends the current port to the webview during initial state sync', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();
		dashboard.show();
		dashboard.setPort(4783);
		panel.webview.postMessage.mockClear();

		dashboard.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4783 });
	});

	it('maps the api port into the webview when the editor tab opens', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();
		dashboard.setPort(4783);

		dashboard.show();

		expect(createWebviewPanelMock).toHaveBeenCalledWith(
			'ungate',
			'Ungate',
			1,
			expect.objectContaining({
				enableScripts: true,
				portMapping: [{ webviewPort: 4783, extensionHostPort: 4783 }]
			})
		);
	});

	it('opens the editor tab without a port mapping while the api port is unknown', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();

		dashboard.show();

		expect(createWebviewPanelMock).toHaveBeenCalledWith('ungate', 'Ungate', 1, expect.objectContaining({ portMapping: [] }));
	});

	it('updates the port mapping of an open editor tab when the api port changes', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = createDashboard();
		dashboard.setPort(4783);
		dashboard.show();

		dashboard.setPort(4790);

		expect(panel.webview.options).toEqual(
			expect.objectContaining({
				enableScripts: true,
				portMapping: [{ webviewPort: 4790, extensionHostPort: 4790 }]
			})
		);
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4790 });
	});

	it('updates the port mapping of an open panel view when the api port changes', () => {
		const view = createView();
		const dashboard = createDashboard();
		dashboard.setPort(4783);
		dashboard.resolveWebviewView(view as never);

		dashboard.setPort(4790);

		expect(view.webview.options).toEqual(
			expect.objectContaining({
				enableScripts: true,
				portMapping: [{ webviewPort: 4790, extensionHostPort: 4790 }]
			})
		);
		expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4790 });
	});

	it('reads shared api logs during initial state sync', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboardA = createDashboard();
		const dashboardB = createDashboard();
		dashboardA.pushLog('api', { timestamp: 1, level: 'info', message: 'started elsewhere' });
		dashboardB.show();
		panel.webview.postMessage.mockClear();

		dashboardB.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: 'log-bulk',
			source: 'api',
			entries: [{ timestamp: 1, level: 'info', message: 'started elsewhere' }]
		});
	});
});
