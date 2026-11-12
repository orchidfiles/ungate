/**
 * Private IPC protocol between the Ungate API child process and the extension host that owns
 * the Cursor session. The API sends credential-free inference requests; the extension attaches
 * the Cursor session token and checksum headers, talks to Cursor's `RunInference` stream and
 * forwards decoded events. Nothing in this protocol ever carries a token, cookie or header.
 */

/** Tag on every bridge message so it can share the Node IPC channel with anything else. */
export const CURSOR_BRIDGE_CHANNEL = 'ungate.cursor-bridge';

/**
 * Socket file, under `~/.ungate`, where an API that no extension spawned (e.g. a systemd service)
 * serves the bridge. The leader window connects to it when it adopts that API. Same messages as
 * the IPC channel, one JSON document per line.
 */
export function cursorBridgeSocketName(port: number): string {
	return `cursor-bridge-${port}.sock`;
}

/** Upper bound for one serialized invoke request (chat history incl. inline images). */
export const CURSOR_BRIDGE_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export type CursorInferenceRole =
	| 'INFERENCE_MESSAGE_ROLE_USER'
	| 'INFERENCE_MESSAGE_ROLE_ASSISTANT'
	| 'INFERENCE_MESSAGE_ROLE_TOOL'
	| 'INFERENCE_MESSAGE_ROLE_SYSTEM';

export type CursorInferenceContentPart = { text: { text: string } } | { image: { data: string; mimeType?: string } };

export interface CursorInferenceToolCall {
	toolCallId: string;
	toolName: string;
	/** JSON object (protobuf `Struct`). */
	args: Record<string, unknown>;
}

export interface CursorInferenceToolResultPart {
	toolCallId: string;
	toolName: string;
	/** protobuf `Value`: any JSON value. */
	result: unknown;
	isError: boolean;
}

/** Connect-JSON shape of `aiserver.v1.InferenceCoreMessage` (subset Ungate uses). */
export interface CursorInferenceMessage {
	role: CursorInferenceRole;
	text?: string;
	parts?: { parts: CursorInferenceContentPart[] };
	toolContent?: { parts: CursorInferenceToolResultPart[] };
	toolCalls?: CursorInferenceToolCall[];
}

/** Connect-JSON shape of `aiserver.v1.InferenceAgentTool`. */
export interface CursorInferenceTool {
	name: string;
	description: string;
	/** Omitted for models that reject structured schemas (schema embedded in `description`). */
	parameters?: Record<string, unknown>;
}

export interface CursorInferenceModelConfig {
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: string[];
}

export interface CursorInferenceRequest {
	/** Cursor model id, e.g. `grok-4.7-low-fast`. */
	modelId: string;
	messages: CursorInferenceMessage[];
	tools: CursorInferenceTool[];
	modelConfig?: CursorInferenceModelConfig;
}

export interface CursorUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number | null;
}

export type CursorBridgeErrorKind =
	| 'disabled'
	| 'unavailable'
	| 'auth'
	| 'rate_limit'
	| 'tool_schema'
	| 'bad_model'
	| 'input_too_long'
	| 'overloaded'
	| 'permission'
	| 'content_filter'
	| 'timeout'
	| 'cancelled'
	| 'upstream';

/** Sanitized upstream error. `message` never includes credentials or raw headers. */
export interface CursorBridgeError {
	kind: CursorBridgeErrorKind;
	message: string;
	/** Connect / RunInference error code when known. */
	code?: number | string;
}

export type CursorSessionReason = 'ok' | 'disabled' | 'no_bridge' | 'no_cursor_api' | 'not_signed_in' | 'error';

/** Safe for dashboards and the tunnel: no token, email or URLs. */
export interface CursorSessionStatus {
	/** The extension bridge is attached and the Cursor API is present. */
	available: boolean;
	/** The user opted in and Cursor reports a signed-in session. */
	connected: boolean;
	reason: CursorSessionReason;
	membershipType: string | null;
}

export type CursorToolCapability = 'structured' | 'embedded';

export interface CursorModelInfo {
	id: string;
	displayName: string;
	thinking: boolean;
	/** Recommended tool schema mode for this model. */
	toolMode: CursorToolCapability;
}

export type CursorBridgeRequest =
	| { channel: typeof CURSOR_BRIDGE_CHANNEL; kind: 'invoke'; id: string; request: CursorInferenceRequest }
	| { channel: typeof CURSOR_BRIDGE_CHANNEL; kind: 'cancel'; id: string }
	| { channel: typeof CURSOR_BRIDGE_CHANNEL; kind: 'listModels'; id: string }
	| { channel: typeof CURSOR_BRIDGE_CHANNEL; kind: 'status'; id: string };

export type CursorBridgeEventBody =
	| { kind: 'ready'; resolvedModel: string | null }
	| { kind: 'text'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'toolCall'; toolCallId: string; toolName: string; args: string; isComplete: boolean; toolIndex: number | null }
	| { kind: 'usage'; usage: CursorUsage }
	| { kind: 'end'; error: CursorBridgeError | null }
	| { kind: 'models'; models: CursorModelInfo[]; error: CursorBridgeError | null }
	| { kind: 'status'; status: CursorSessionStatus };

export type CursorBridgeEvent = { channel: typeof CURSOR_BRIDGE_CHANNEL; id: string } & CursorBridgeEventBody;

export function isCursorBridgeMessage(
	value: unknown
): value is { channel: typeof CURSOR_BRIDGE_CHANNEL; kind: string; id: string } {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;

	return record.channel === CURSOR_BRIDGE_CHANNEL && typeof record.kind === 'string' && typeof record.id === 'string';
}

/**
 * Tool schema mode a Cursor model needs. Grok on Cursor's `RunInference` rejects any tool that
 * carries structured `parameters` (provider 422), but follows a JSON Schema embedded in the
 * tool description; other models (Composer, Claude, GPT) accept structured parameters.
 */
export function cursorToolCapabilityForModel(modelId: string): CursorToolCapability {
	return /(^|[^a-z])grok/i.test(modelId) ? 'embedded' : 'structured';
}
