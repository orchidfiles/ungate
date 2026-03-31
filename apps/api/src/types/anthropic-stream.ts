/**
 * Anthropic streaming event types.
 * Used for SSE parsing in openai-stream-handler.ts.
 */

export interface AnthropicUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export interface AnthropicStreamTextBlock {
	type: 'text';
	text: string;
}

export interface AnthropicStreamToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
}

export type AnthropicStreamBlock = AnthropicStreamTextBlock | AnthropicStreamToolUseBlock;

export interface AnthropicStreamTextDelta {
	type: 'text_delta';
	text: string;
}

export interface AnthropicStreamInputJsonDelta {
	type: 'input_json_delta';
	partial_json: string;
}

export type AnthropicStreamDelta = AnthropicStreamTextDelta | AnthropicStreamInputJsonDelta;

export type AnthropicStreamEvent =
	| { type: 'message_start'; message: { usage: AnthropicUsage } }
	| { type: 'content_block_start'; index: number; content_block: AnthropicStreamBlock }
	| { type: 'content_block_delta'; index: number; delta: AnthropicStreamDelta }
	| { type: 'content_block_stop'; index: number }
	| { type: 'message_delta'; usage: { output_tokens: number } }
	| { type: 'message_stop' };
