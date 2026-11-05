import { DEFAULT_AUTO_TUNNEL_ENABLED, DEFAULT_KEY_FIX_ENABLED, type RuntimeState } from '@ungate/shared/frontend';
import { vi } from 'vitest';

export class TestHelper {
	public static createRuntimeState(windowIds: string[], apiPort: number | null = 4783): RuntimeState {
		const clients = Object.fromEntries(
			windowIds.map((windowId) => {
				return [windowId, { lastSeenAt: Date.now() }];
			})
		);
		const runtimeState: RuntimeState = {
			api: {
				pid: apiPort ? 1234 : null,
				port: apiPort,
				status: apiPort ? 'running' : 'stopped',
				lastSeenAt: Date.now(),
				lastError: null,
				ownerWindowId: null,
				startSuppressed: false
			},
			tunnel: {
				status: 'stopped',
				url: null,
				lastError: null,
				ownerWindowId: null,
				lastSeenAt: 0
			},
			keyFix: {
				enabled: DEFAULT_KEY_FIX_ENABLED
			},
			autoTunnel: {
				enabled: DEFAULT_AUTO_TUNNEL_ENABLED,
				lastAppliedUrl: null
			},
			clients,
			commands: []
		};

		return runtimeState;
	}

	public static createMarkdownStringClass() {
		return class MarkdownString {
			public value: string;
			public isTrusted = false;

			constructor(value = '') {
				this.value = value;
			}

			appendMarkdown(markdown: string): void {
				this.value += markdown;
			}
		};
	}

	public static createDashboardPanel() {
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
}
