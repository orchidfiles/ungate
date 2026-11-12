export interface ProxyConfig {
	port: number;
	/** Addresses to listen on, from `HOST` (comma-separated); all interfaces when unset. */
	hosts: string[];
	apiKey?: string;
	quietMode: boolean;
}

export * from './anthropic';
export * from './auth';
export * from './openai';
export * from './proxy';

export type { RequestSource } from '@ungate/shared';
