import type { RequestSource, Tool } from './index';

export interface RequestContext {
	model: string;
	source: RequestSource;
	startTime: number;
	reverseToolMapping: Record<string, string>;
	inputTokens?: number;
	outputTokens?: number;
	bodyJson?: unknown;
	/**
	 * Post-commit hook for an upstream error delivered inside an already-forwarded stream. Never
	 * retries; lets the proxy client cool down the serving account when it is a usage limit.
	 */
	onStreamError?: (error: Record<string, unknown> | undefined) => void;
	/** The response body records its own single analytics row at stream end (success or failure). */
	telemetryDeferred?: boolean;
}

export interface ProxyResult {
	response: Response;
	context: RequestContext;
}

export interface ToolMapResult {
	tools: Tool[];
	reverseMapping: Record<string, string>;
}

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	input: Record<string, any>;
}

export interface StreamResult {
	stream: ReadableStream;
	headers: Record<string, string>;
}
