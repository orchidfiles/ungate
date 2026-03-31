import type { RequestSource, Tool } from './index';

export interface RequestContext {
	model: string;
	source: RequestSource;
	startTime: number;
	reverseToolMapping: Record<string, string>;
	inputTokens?: number;
	outputTokens?: number;
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
