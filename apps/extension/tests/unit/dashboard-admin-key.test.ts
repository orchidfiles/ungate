import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

const createWebviewPanelMock = vi.fn();
const fileUriMock = vi.fn((value: string) => {
	return { fsPath: value, toString: () => value };
});

let indexHtml = '<html><head></head><body></body></html>';

vi.mock('node:fs', () => {
	return {
		readFileSync: vi.fn(() => indexHtml)
	};
});

vi.mock('../../src/runtime-state/shared-log-store', () => {
	return {
		SharedLogStore: {
			append() {},
			readAll() {
				return [];
			},
			readSince() {
				return { entries: [], nextOffset: 0 };
			},
			getFileSize() {
				return 0;
			},
			clear() {}
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
let toInlineScriptJson: typeof import('../../src/dashboard').toInlineScriptJson;

function createPanel() {
	return {
		webview: {
			html: '',
			postMessage: vi.fn(),
			asWebviewUri: vi.fn((value) => value),
			onDidReceiveMessage: vi.fn()
		},
		onDidChangeViewState: vi.fn(),
		onDidDispose: vi.fn(),
		reveal: vi.fn(),
		visible: true,
		iconPath: null
	};
}

function showDashboard(adminApiKey: string) {
	const panel = createPanel();
	createWebviewPanelMock.mockReturnValue(panel);

	const dashboard = new Dashboard(
		{
			extensionMode: 1,
			extensionPath: '/tmp/ungate-extension'
		} as never,
		adminApiKey,
		() => {}
	);
	dashboard.show();

	return { dashboard, panel };
}

describe('Dashboard admin key injection', () => {
	beforeAll(async () => {
		const module = await import('../../src/dashboard');
		Dashboard = module.Dashboard;
		toInlineScriptJson = module.toInlineScriptJson;
	});

	beforeEach(() => {
		createWebviewPanelMock.mockReset();
		fileUriMock.mockClear();
		indexHtml = '<html><head></head><body></body></html>';
	});

	it('injects the admin key and port into the webview bootstrap', () => {
		const { panel } = showDashboard('f'.repeat(64));

		expect(panel.webview.html).toContain(`window.__ADMIN_KEY__ = "${'f'.repeat(64)}"`);
		expect(panel.webview.html).toContain('window.__PORT__ = null');
	});

	it('keeps the injected key inside the script element when it contains HTML', () => {
		// A key can only be hex or base64url in practice, but the injection must stay inert for any
		// value: an unescaped `</script>` would end the element and turn the rest into markup.
		const hostileKey = '</script><img src=x onerror=alert(1)>';
		const { panel } = showDashboard(hostileKey);

		expect(panel.webview.html).not.toContain('</script><img');
		expect(panel.webview.html).not.toContain('<img src=x');
		expect(panel.webview.html).toContain('\\u003c/script\\u003e');
	});

	it('escapes every character that could break out of an inline script', () => {
		expect(toInlineScriptJson('</script>')).toBe('"\\u003c/script\\u003e"');
		expect(toInlineScriptJson('a&b')).toBe('"a\\u0026b"');
		expect(toInlineScriptJson('line\u2028break')).toBe('"line\\u2028break"');
		expect(toInlineScriptJson('para\u2029break')).toBe('"para\\u2029break"');
		expect(toInlineScriptJson(null)).toBe('null');
		expect(toInlineScriptJson(4783)).toBe('4783');
	});

	it('does not let a key containing $ patterns corrupt the surrounding html', () => {
		// A plain replacement string would expand `$&` into the matched `</head>` and `` $` `` into
		// everything before it. The `&` is separately escaped as \u0026; the `$` runs must survive
		// verbatim, which is what proves no replacement-pattern expansion happened.
		const { panel } = showDashboard('$&$`$0');

		expect(panel.webview.html).toContain('window.__ADMIN_KEY__ = "$\\u0026$`$0"');
		expect(panel.webview.html).toContain('</head>');
		expect(panel.webview.html).toContain('<body></body>');
	});

	it('re-injects the current port on rebuild without dropping the admin key', () => {
		const { dashboard, panel } = showDashboard('f'.repeat(64));

		dashboard.setPort(4783);

		expect(panel.webview.html).toContain('window.__PORT__ = 4783');
		expect(panel.webview.html).toContain(`window.__ADMIN_KEY__ = "${'f'.repeat(64)}"`);
	});
});
