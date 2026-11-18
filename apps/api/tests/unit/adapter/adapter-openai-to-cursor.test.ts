import { describe, expect, it } from 'vitest';

import {
	buildCursorTools,
	EMBEDDED_TOOL_ARGUMENTS_INSTRUCTION,
	findInvalidToolCalls,
	resolveCursorToolCapability,
	validateToolArguments
} from 'src/adapter/cursor-tool-capability';
import { CursorRequestError, openaiToCursor } from 'src/adapter/openai-to-cursor';

import type { OpenAIChatRequest, OpenAITool } from 'src/types/openai';

const readTool: OpenAITool = {
	type: 'function',
	function: {
		name: 'Read',
		description: 'Read a file',
		parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
	}
};

const body = (extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest =>
	({ model: 'cursor-grok', stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra }) as OpenAIChatRequest;

describe('openaiToCursor', () => {
	it('does not infer native context or built-in status from model names', () => {
		for (const upstreamModel of ['composer-2.5', 'grok-4.7-low-fast', 'claude-sonnet-4.6']) {
			const { request } = openaiToCursor(body(), { upstreamModel });
			expect(request).not.toHaveProperty('conversationId');
			expect(request).not.toHaveProperty('previousRequestId');
			expect(request).not.toHaveProperty('builtInModel');
		}
	});

	it('maps roles, tool history and parallel tool results', () => {
		const { request } = openaiToCursor(
			body({
				messages: [
					{ role: 'system', content: 'be brief' },
					{ role: 'user', content: 'read two files' },
					{
						role: 'assistant',
						content: null,
						tool_calls: [
							{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } },
							{ id: 'c2', type: 'function', function: { name: 'Read', arguments: '{"path":"b"}' } }
						]
					},
					{ role: 'tool', tool_call_id: 'c1', content: 'A' },
					{ role: 'tool', tool_call_id: 'c2', content: 'B' }
				] as OpenAIChatRequest['messages'],
				tools: [readTool],
				max_tokens: 512
			}),
			{ upstreamModel: 'composer-2.5-fast' }
		);

		expect(request.modelId).toBe('composer-2.5-fast');
		expect(request.modelConfig).toEqual({ maxTokens: 512 });
		expect(request.messages.map((message) => message.role)).toEqual([
			'INFERENCE_MESSAGE_ROLE_SYSTEM',
			'INFERENCE_MESSAGE_ROLE_USER',
			'INFERENCE_MESSAGE_ROLE_ASSISTANT',
			'INFERENCE_MESSAGE_ROLE_TOOL'
		]);
		expect(request.messages[2].toolCalls).toEqual([
			{ toolCallId: 'c1', toolName: 'Read', args: { path: 'a' } },
			{ toolCallId: 'c2', toolName: 'Read', args: { path: 'b' } }
		]);
		expect(request.messages[3].toolContent?.parts).toEqual([
			{ toolCallId: 'c1', toolName: 'Read', result: 'A', isError: false },
			{ toolCallId: 'c2', toolName: 'Read', result: 'B', isError: false }
		]);
		expect(request.tools[0].parameters).toEqual(readTool.function.parameters);
	});

	it('maps inline images to parts and rejects remote images', () => {
		const { request } = openaiToCursor(
			body({
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'look' },
							{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
						]
					}
				] as OpenAIChatRequest['messages']
			}),
			{ upstreamModel: 'composer-2.5' }
		);
		expect(request.messages[0].parts?.parts).toEqual([
			{ text: { text: 'look' } },
			{ image: { data: 'AAAA', mimeType: 'image/png' } }
		]);

		expect(() =>
			openaiToCursor(
				body({
					messages: [
						{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }
					] as OpenAIChatRequest['messages']
				}),
				{ upstreamModel: 'composer-2.5' }
			)
		).toThrow(CursorRequestError);
	});

	it('rejects unsupported inputs with a 400 error', () => {
		const cases: Partial<OpenAIChatRequest>[] = [
			{ n: 2 } as never,
			{ response_format: { type: 'json_schema' } } as never,
			{ messages: [] },
			{ messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] } as never
		];
		for (const extra of cases) {
			expect(() => openaiToCursor(body(extra), { upstreamModel: 'composer-2.5' })).toThrow(
				expect.objectContaining({ name: 'CursorRequestError', status: 400 })
			);
		}
	});

	it('drops tools when tool_choice is none', () => {
		const { request } = openaiToCursor(body({ tools: [readTool], tool_choice: 'none' }), { upstreamModel: 'composer-2.5' });
		expect(request.tools).toEqual([]);
	});
});

describe('Cursor tool capability', () => {
	it('detects Grok as embedded and honors per-mapping overrides', () => {
		expect(resolveCursorToolCapability('grok-4.7-low-fast', null)).toBe('embedded');
		expect(resolveCursorToolCapability('composer-2.5-fast', undefined)).toBe('structured');
		expect(resolveCursorToolCapability('grok-4.7-high', 'structured')).toBe('structured');
		expect(resolveCursorToolCapability('composer-2.5', 'embedded')).toBe('embedded');
		expect(resolveCursorToolCapability('grok-4.7-high', 'auto')).toBe('embedded');
	});

	it('embeds the schema in the description and omits parameters', () => {
		const [tool] = buildCursorTools([readTool], 'embedded');
		expect(tool.parameters).toBeUndefined();
		expect(tool.description).toBe(
			`Read a file\n\nArguments must be a JSON object matching this JSON Schema:\n${JSON.stringify(readTool.function.parameters)}\nRequired arguments: path. Never call this tool with an empty object.`
		);
		const [structured] = buildCursorTools([readTool], 'structured');
		expect(structured).toEqual({ name: 'Read', description: 'Read a file', parameters: readTool.function.parameters });
	});

	it('validates required fields and types', () => {
		const schema = readTool.function.parameters!;
		expect(validateToolArguments(schema, { path: 'a' })).toEqual([]);
		expect(validateToolArguments(schema, {})).toEqual(['$.path is required']);
		expect(validateToolArguments(schema, { path: 3 })).toEqual(['$.path should be string']);
		expect(validateToolArguments(schema, [])).toEqual(['$ should be object']);
	});

	it('omits the required line for tools without required arguments', () => {
		const [tool] = buildCursorTools(
			[{ type: 'function', function: { name: 'List', parameters: { type: 'object', properties: {} } } }],
			'embedded'
		);
		expect(tool.description).not.toContain('Required arguments');
	});

	it('finds empty, unparseable and mistyped tool calls', () => {
		const invalid = findInvalidToolCalls(
			[readTool],
			[
				{ id: 'a', name: 'Read', args: '{"path":"x"}' },
				{ id: 'b', name: 'Read', args: '{}' },
				{ id: 'c', name: 'Read', args: '' },
				{ id: 'd', name: 'Read', args: '{"path":' },
				{ id: 'e', name: 'Unknown', args: '{}' }
			]
		);
		expect(invalid.map((call) => [call.id, call.problems])).toEqual([
			['b', ['$.path is required']],
			['c', ['$.path is required']],
			['d', ['arguments are not valid JSON']]
		]);
	});

	it('adds the tool-argument instruction for embedded mode only', () => {
		const withSystem = body({
			tools: [readTool],
			messages: [
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'hi' }
			] as OpenAIChatRequest['messages']
		});
		const embedded = openaiToCursor(withSystem, { upstreamModel: 'grok-4.7-high' }).request;
		expect(embedded.messages.map((message) => message.text)).toEqual(['be brief', EMBEDDED_TOOL_ARGUMENTS_INSTRUCTION, 'hi']);

		const structured = openaiToCursor(withSystem, { upstreamModel: 'composer-2.5' }).request;
		expect(structured.messages.map((message) => message.text)).toEqual(['be brief', 'hi']);

		const noTools = openaiToCursor(body(), { upstreamModel: 'grok-4.7-high' }).request;
		expect(noTools.messages).toHaveLength(1);
	});
});
