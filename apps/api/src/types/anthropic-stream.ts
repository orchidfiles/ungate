/**
 * Anthropic streaming event types.
 * Used for SSE parsing in openai-stream-handler.ts.
 */

import type { AnthropicStopReason } from './anthropic';

export type { AnthropicStopReason };

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

export interface AnthropicStreamThinkingBlock {
	type: 'thinking';
	thinking?: string;
}

export type AnthropicStreamBlock = AnthropicStreamTextBlock | AnthropicStreamToolUseBlock | AnthropicStreamThinkingBlock;

export interface AnthropicStreamTextDelta {
	type: 'text_delta';
	text: string;
}

export interface AnthropicStreamInputJsonDelta {
	type: 'input_json_delta';
	partial_json: string;
}

export interface AnthropicStreamThinkingDelta {
	type: 'thinking_delta';
	thinking: string;
}

export interface AnthropicStreamSignatureDelta {
	type: 'signature_delta';
	signature: string;
}

export type AnthropicStreamDelta =
	| AnthropicStreamTextDelta
	| AnthropicStreamInputJsonDelta
	| AnthropicStreamThinkingDelta
	| AnthropicStreamSignatureDelta;

export type AnthropicStreamEvent =
	| { type: 'message_start'; message: { usage: AnthropicUsage } }
	| { type: 'content_block_start'; index: number; content_block: AnthropicStreamBlock }
	| { type: 'content_block_delta'; index: number; delta: AnthropicStreamDelta }
	| { type: 'content_block_stop'; index: number }
	| {
			type: 'message_delta';
			delta?: { stop_reason?: AnthropicStopReason | null };
			usage?: { output_tokens: number };
	  }
	| { type: 'message_stop' };
