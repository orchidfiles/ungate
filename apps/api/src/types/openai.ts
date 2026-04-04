export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool' | 'developer' | 'function';
	content: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

export interface OpenAIContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: {
		url: string;
		detail?: 'auto' | 'low' | 'high';
	};
}

export interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean;
	};
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIMessage[];
	/** Some clients send the thread as `input` (chat roles or Responses items) instead of `messages`. */
	input?: unknown;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stream?: boolean;
	stop?: string | string[];
	presence_penalty?: number;
	frequency_penalty?: number;
	user?: string;
	tools?: OpenAITool[];
	tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
	reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
	reasoning?: {
		effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
	};
}

export interface OpenAIChatResponse {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: {
		index: number;
		message: {
			role: 'assistant';
			content: string | null;
			tool_calls?: OpenAIToolCall[];
		};
		finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
	}[];
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface OpenAIStreamChunkToolCall {
	index: number;
	id?: string;
	type?: 'function';
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface OpenAIStreamChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: {
		index: number;
		delta: {
			role?: 'assistant';
			content?: string | null;
			tool_calls?: OpenAIStreamChunkToolCall[];
		};
		finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
	}[];
}
