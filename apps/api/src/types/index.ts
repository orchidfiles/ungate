export interface ProxyConfig {
	port: number;
	/** Proxy key Cursor sends on completion and model-listing routes. */
	apiKey?: string;
	/** Separate 256-bit key required on every administrative route. Never persisted to SQLite. */
	adminApiKey: string;
	quietMode: boolean;
}

export * from './anthropic';
export * from './auth';
export * from './openai';
export * from './proxy';

export type { RequestSource } from '@ungate/shared';
