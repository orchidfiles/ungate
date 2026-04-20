export * from './types';
export * from './constants';
export * from './guards';
export * from './helpers/model-provider';
export * from './helpers/provider-labels';

import type { LogEntry, TunnelState } from './types';

export type ExtensionToWebview =
	| { type: 'port'; port: number | null }
	| { type: 'tunnel-status'; state: TunnelState }
	| { type: 'log'; source: 'api' | 'tunnel'; entry: LogEntry }
	| { type: 'log-bulk'; source: 'api' | 'tunnel'; entries: LogEntry[] };

export type WebviewToExtension =
	| { type: 'webview-ready' }
	| { type: 'restart-server' }
	| { type: 'start-tunnel' }
	| { type: 'stop-tunnel' }
	| { type: 'restart-tunnel' };
