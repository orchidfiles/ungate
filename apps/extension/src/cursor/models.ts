import { cursorToolCapabilityForModel, type CursorModelInfo } from '@ungate/shared';

import { connectUnary, type Http2Connect } from './connect-transport';
import { redactMessage } from './run-inference';

import type { CursorRequestCredentials } from './cursor-session';

export const GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

const MAX_MODELS = 500;

export class CursorModelsError extends Error {
	constructor(
		readonly kind: 'auth' | 'upstream',
		message: string
	) {
		super(message);
		this.name = 'CursorModelsError';
	}
}

export function parseUsableModels(body: unknown): CursorModelInfo[] {
	const models = (body as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) return [];

	const seen = new Set<string>();
	const out: CursorModelInfo[] = [];

	for (const raw of models.slice(0, MAX_MODELS)) {
		if (typeof raw !== 'object' || raw === null) continue;
		const record = raw as Record<string, unknown>;
		const id = typeof record.modelId === 'string' ? record.modelId.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const displayName =
			(typeof record.displayName === 'string' && record.displayName) ||
			(typeof record.displayModelId === 'string' && record.displayModelId) ||
			id;

		out.push({
			id,
			displayName,
			thinking: record.thinkingDetails !== undefined && record.thinkingDetails !== null,
			toolMode: cursorToolCapabilityForModel(id)
		});
	}

	return out;
}

export async function fetchUsableModels(
	creds: CursorRequestCredentials,
	options: { timeoutMs?: number; connect?: Http2Connect } = {}
): Promise<CursorModelInfo[]> {
	const { status, body } = await connectUnary({
		url: creds.backendUrl,
		path: GET_USABLE_MODELS_PATH,
		headers: creds.headers,
		body: {},
		timeoutMs: options.timeoutMs ?? 15_000,
		connect: options.connect
	});

	if (status === 401 || status === 403) {
		throw new CursorModelsError('auth', 'Sign in to Cursor to list models');
	}

	if (status !== 200) {
		const message =
			typeof (body as { message?: unknown } | null)?.message === 'string' ? (body as { message: string }).message : '';
		throw new CursorModelsError('upstream', redactMessage(message || `Cursor responded with HTTP ${status}`));
	}

	return parseUsableModels(body);
}
