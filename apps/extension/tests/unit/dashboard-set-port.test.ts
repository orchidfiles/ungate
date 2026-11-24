import * as fs from 'node:fs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

const executeCommandMock = vi.fn();
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
		window: {},
		commands: {
			executeCommand: executeCommandMock
		},
		ViewColumn: {
			One: 1
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

describe('Dashboard.setPort', () => {
	beforeAll(async () => {
		const module = await import('../../src/dashboard');
		Dashboard = module.Dashboard;
	});

	beforeEach(() => {
		executeCommandMock.mockReset();
		fileUriMock.mockClear();
		sharedLogs.api.length = 0;
		sharedLogs.tunnel.length = 0;
	});

	it('drops the crossorigin attribute so the panel can load its script', () => {
		vi.mocked(fs.readFileSync).mockReturnValueOnce(
			'<html><head><script type="module" crossorigin src="/assets/index.js"></script><link rel="stylesheet" crossorigin href="/assets/index.css"></head><body></body></html>'
		);
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 2,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);

		dashboard.resolveWebviewView(panel as never);

		expect(panel.webview.html).not.toContain('crossorigin');
		expect(panel.webview.html).toContain('src="/tmp/ungate-extension/bundled/web/dist/assets/index.js"');
	});

	it('focuses the panel view instead of an editor tab', () => {
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);

		dashboard.show();

		expect(executeCommandMock).toHaveBeenCalledWith('ungate.dashboard.focus');
	});

	it('does not rebuild the webview when the port did not change', () => {
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.resolveWebviewView(panel as never);

		const rebuildSpy = vi.spyOn(dashboard as unknown as { rebuildHtml(): void }, 'rebuildHtml');

		dashboard.setPort(4783);
		rebuildSpy.mockClear();
		panel.webview.postMessage.mockClear();

		dashboard.setPort(4783);

		expect(rebuildSpy).not.toHaveBeenCalled();
		expect(panel.webview.postMessage).not.toHaveBeenCalled();
	});

	it('sends the current port to the webview during initial state sync', () => {
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.resolveWebviewView(panel as never);
		dashboard.setPort(4783);
		panel.webview.postMessage.mockClear();

		dashboard.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4783 });
	});

	it('maps the api port into the webview when the panel opens', () => {
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.setPort(4783);

		dashboard.resolveWebviewView(panel as never);

		expect(panel.webview.options).toEqual(
			expect.objectContaining({
				enableScripts: true,
				portMapping: [{ webviewPort: 4783, extensionHostPort: 4783 }]
			})
		);
	});

	it('opens the panel without a port mapping while the api port is unknown', () => {
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);

		dashboard.resolveWebviewView(panel as never);

		expect(panel.webview.options).toEqual(expect.objectContaining({ portMapping: [] }));
	});

	it('updates the port mapping of an open panel when the api port changes', () => {
		const panel = createView();
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.setPort(4783);
		dashboard.resolveWebviewView(panel as never);

		dashboard.setPort(4790);

		expect(panel.webview.options).toEqual(
			expect.objectContaining({
				enableScripts: true,
				portMapping: [{ webviewPort: 4790, extensionHostPort: 4790 }]
			})
		);
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4790 });
	});

	it('reads shared api logs during initial state sync', () => {
		const panel = createView();
		const dashboardA = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		const dashboardB = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboardA.pushLog('api', { timestamp: 1, level: 'info', message: 'started elsewhere' });
		dashboardB.resolveWebviewView(panel as never);
		panel.webview.postMessage.mockClear();

		dashboardB.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: 'log-bulk',
			source: 'api',
			entries: [{ timestamp: 1, level: 'info', message: 'started elsewhere' }]
		});
	});
});
