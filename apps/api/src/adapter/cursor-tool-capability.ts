import {
	cursorToolCapabilityForModel,
	type CursorInferenceTool,
	type CursorToolCapability,
	type CursorToolMode
} from '@ungate/shared';
import { logger } from 'src/utils/logger';

import type { OpenAITool } from 'src/types/openai';

const EMBEDDED_SCHEMA_PREFIX = 'Arguments must be a JSON object matching this JSON Schema:';
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** Resolves the per-mapping override (`auto` / null = detect from the model id). */
export function resolveCursorToolCapability(modelId: string, override: CursorToolMode | null | undefined): CursorToolCapability {
	if (override === 'structured' || override === 'embedded') return override;

	return cursorToolCapabilityForModel(modelId);
}

/**
 * Builds Cursor `InferenceAgentTool`s. `structured` sends the JSON Schema as `parameters`.
 * `embedded` is for models (Grok) whose Cursor backend rejects structured parameters: the
 * schema goes into the description and `parameters` is omitted.
 */
export function buildCursorTools(tools: OpenAITool[] | undefined, capability: CursorToolCapability): CursorInferenceTool[] {
	if (!tools?.length) return [];

	return tools
		.filter((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.name)
		.map((tool) => {
			const schema = tool.function.parameters ?? EMPTY_OBJECT_SCHEMA;
			const description = tool.function.description ?? '';

			if (capability === 'structured') {
				return { name: tool.function.name, description, parameters: schema };
			}

			const embedded = `${EMBEDDED_SCHEMA_PREFIX}\n${JSON.stringify(schema)}${requiredArgumentsLine(schema)}`;

			return { name: tool.function.name, description: description ? `${description}\n\n${embedded}` : embedded };
		});
}

function requiredKeys(schema: Record<string, unknown> | undefined): string[] {
	const required = schema?.required;

	return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : [];
}

/** Embedded schemas are only prose to Grok, so the required keys are spelled out. */
function requiredArgumentsLine(schema: Record<string, unknown>): string {
	const keys = requiredKeys(schema);
	if (keys.length === 0) return '';

	return `\nRequired arguments: ${keys.join(', ')}. Never call this tool with an empty object.`;
}

/**
 * System instruction for `embedded` tool mode: without structured `parameters`, Grok
 * occasionally emits whole batches of parallel calls with `{}` arguments.
 */
export const EMBEDDED_TOOL_ARGUMENTS_INSTRUCTION =
	"Tool calls: every tool call must include a complete JSON arguments object that satisfies the JSON Schema in that tool's description, with all required arguments filled in. This applies to each call when you make several calls in parallel. Never send an empty arguments object to a tool that has required arguments.";

export interface ToolCallCheckInput {
	id: string;
	name: string;
	args: string;
}

export interface InvalidToolCall extends ToolCallCheckInput {
	problems: string[];
}

/**
 * Tool calls whose arguments cannot work: unparseable JSON, missing required keys or wrong
 * types. Unknown tools are left alone (the client reports them itself).
 */
export function findInvalidToolCalls(tools: OpenAITool[] | undefined, calls: ToolCallCheckInput[]): InvalidToolCall[] {
	const invalid: InvalidToolCall[] = [];

	for (const call of calls) {
		const tool = tools?.find((entry) => entry.function?.name === call.name);
		if (!tool) continue;

		let parsed: unknown;
		try {
			parsed = call.args.trim() ? JSON.parse(call.args) : {};
		} catch {
			invalid.push({ ...call, problems: ['arguments are not valid JSON'] });
			continue;
		}

		const problems = validateToolArguments(tool.function.parameters, parsed);
		if (problems.length > 0) invalid.push({ ...call, problems });
	}

	return invalid;
}

type JsonSchema = Record<string, unknown>;

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		case 'object':
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		case 'null':
			return value === null;
		default:
			return true;
	}
}

/**
 * Small structural check (required fields + top-level/nested property types). Returns the
 * problems found; an empty list means the arguments look valid. Unknown keywords are ignored.
 */
export function validateToolArguments(schema: JsonSchema | undefined, args: unknown, path = '$', depth = 0): string[] {
	if (!schema || depth > 6) return [];
	const problems: string[] = [];
	const declared = schema.type;
	const types = Array.isArray(declared)
		? declared.filter((t): t is string => typeof t === 'string')
		: typeof declared === 'string'
			? [declared]
			: [];

	if (types.length > 0 && !types.some((type) => typeMatches(args, type))) {
		return [`${path} should be ${types.join(' | ')}`];
	}

	if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(args))) {
		problems.push(`${path} is not one of the allowed values`);
	}

	if (typeMatches(args, 'object') && (types.length === 0 || types.includes('object'))) {
		const record = args as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
		const required = Array.isArray(schema.required)
			? schema.required.filter((key): key is string => typeof key === 'string')
			: [];

		for (const key of required) {
			if (!(key in record)) problems.push(`${path}.${key} is required`);
		}

		for (const [key, value] of Object.entries(record)) {
			const child = properties[key];
			if (child && typeof child === 'object') problems.push(...validateToolArguments(child, value, `${path}.${key}`, depth + 1));
		}
	}

	if (Array.isArray(args) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
		args.slice(0, 50).forEach((item, index) => {
			problems.push(...validateToolArguments(schema.items as JsonSchema, item, `${path}[${index}]`, depth + 1));
		});
	}

	return problems;
}

/**
 * Checks a finished tool call against the original OpenAI schema. Mismatches are only logged:
 * the call still goes to Cursor, whose tool layer reports argument errors back to the model.
 */
export function checkToolCallArguments(tools: OpenAITool[] | undefined, name: string, rawArgs: string, modelId: string): void {
	const tool = tools?.find((entry) => entry.function?.name === name);
	if (!tool) {
		logger.warn(`[cursor] ${modelId} called unknown tool ${name}`);

		return;
	}

	let parsed: unknown;
	try {
		parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
	} catch {
		logger.warn(`[cursor] ${modelId} returned non-JSON arguments for ${name}`);

		return;
	}

	const problems = validateToolArguments(tool.function.parameters, parsed);
	if (problems.length > 0) {
		logger.warn(`[cursor] ${modelId} arguments for ${name} do not match schema: ${problems.slice(0, 5).join('; ')}`);
	}
}
