// End-to-end check of the Cursor provider through a running Ungate API:
// session status, model list, plain stream, a sandboxed multi-turn tool loop, tier routing, cancel.
// Tool calls are answered from an in-memory sandbox; nothing the model asks for is executed.
//
// Usage: pnpm --filter @ungate/scripts validate-cursor [--model cursor-grok-4.7-high] [--only status,loop]

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Json = Record<string, unknown>;

interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

interface Completion {
	status: number;
	text: string;
	toolCalls: ToolCall[];
	finishReason: string | null;
	done: boolean;
	error: unknown;
	chunks: number;
}

interface RequestRow {
	model: string | null;
	source: string | null;
	stop_reason: string | null;
	tool_call_count: number | null;
	tool_names: string | null;
	error: string | null;
	reasoning_tier: string | null;
}

interface ToolSchema {
	properties: Record<string, { type: string }>;
	required: string[];
}

interface ChunkDelta {
	content?: string;
	tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
	error?: unknown;
	choices?: { delta?: ChunkDelta; finish_reason?: string | null }[];
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const index = args.indexOf(`--${name}`);

	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const MODEL = flag('model', 'cursor-grok-4.7-high');
const ONLY = flag('only', '').split(',').filter(Boolean);
const DB_PATH = process.env.DB_PATH ?? join(homedir(), '.ungate', 'data.db');
const RUNTIME = JSON.parse(readFileSync(join(homedir(), '.ungate', 'runtime-state.json'), 'utf8')) as {
	api: { port: number; pid: number };
};
const BASE = `http://localhost:${RUNTIME.api.port}`;

// node:sqlite avoids depending on the API's ABI-specific better-sqlite3 build.
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const keyRow = db.prepare('SELECT api_key FROM app_settings LIMIT 1').get() as { api_key?: string } | undefined;
const API_KEY = keyRow?.api_key ?? '';

const results: { name: string; ok: boolean }[] = [];
const record = (name: string, ok: boolean, evidence: string) => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${evidence}`);
};

function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` }
	});
}

async function* sse(response: Response): AsyncGenerator<string> {
	if (!response.body) return;
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let cut = buffer.indexOf('\n\n');
		while (cut >= 0) {
			const frame = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 2);
			for (const line of frame.split('\n')) {
				if (line.startsWith('data: ')) yield line.slice(6);
			}
			cut = buffer.indexOf('\n\n');
		}
	}
}

/** Streams one completion and folds it into text, tool calls and finish state. */
async function complete(
	body: Json,
	options: { signal?: AbortSignal; onChunk?: (chunk: Chunk) => void } = {}
): Promise<Completion> {
	const out: Completion = { status: 0, text: '', toolCalls: [], finishReason: null, done: false, error: null, chunks: 0 };
	const response = await api('/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({ stream: true, ...body }),
		signal: options.signal
	});
	out.status = response.status;
	if (!response.ok) {
		out.error = await response.text();

		return out;
	}

	for await (const data of sse(response)) {
		if (data === '[DONE]') {
			out.done = true;
			continue;
		}
		const chunk = JSON.parse(data) as Chunk;
		if (chunk.error) out.error = chunk.error;
		out.chunks++;
		options.onChunk?.(chunk);
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta ?? {};
			if (delta.content) out.text += delta.content;
			for (const call of delta.tool_calls ?? []) {
				out.toolCalls[call.index] ??= { id: '', name: '', arguments: '' };
				const slot = out.toolCalls[call.index];
				if (call.id) slot.id = call.id;
				if (call.function?.name) slot.name += call.function.name;
				if (call.function?.arguments) slot.arguments += call.function.arguments;
			}
			if (choice.finish_reason) out.finishReason = choice.finish_reason;
		}
	}

	return out;
}

const latestRequest = (): RequestRow | undefined =>
	db
		.prepare(
			'SELECT model, source, stop_reason, tool_call_count, tool_names, error, reasoning_tier FROM requests ORDER BY id DESC LIMIT 1'
		)
		.get() as RequestRow | undefined;

const describeError = (error: unknown): string => (typeof error === 'string' ? error : JSON.stringify(error));

// Cursor agent tool shapes (names and parameters as Cursor sends them to a custom base URL).
interface ToolDef {
	type: 'function';
	function: { name: string; description: string; parameters: ToolSchema & { type: 'object' } };
}

const TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'Read',
			description: 'Read a file from the local filesystem.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					offset: { type: 'integer' },
					limit: { type: 'integer' }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'Grep',
			description: 'Search file contents with a regular expression.',
			parameters: {
				type: 'object',
				properties: { pattern: { type: 'string' }, path: { type: 'string' } },
				required: ['pattern']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'Shell',
			description: 'Run a shell command.',
			parameters: {
				type: 'object',
				properties: { command: { type: 'string' }, description: { type: 'string' } },
				required: ['command']
			}
		}
	}
];

const MARKER = `ORCHID-${randomUUID().slice(0, 8).toUpperCase()}`;
const SANDBOX: Record<string, string> = {
	'/workspace/config/release.env': `APP_NAME=ungate\nRELEASE_CODENAME=${MARKER}\nCHANNEL=stable\n`,
	'/workspace/README.md': '# Workspace\nRelease settings live in config/release.env.\n'
};

type ArgCheck = { ok: true; parsed: Record<string, unknown> } | { ok: false; why: string };

function validateArgs(tool: string, raw: string): ArgCheck {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
	} catch {
		return { ok: false, why: `arguments are not JSON: ${raw.slice(0, 120)}` };
	}
	const schema = TOOLS.find((t) => t.function.name === tool)?.function.parameters;
	if (!schema) return { ok: false, why: `unknown tool ${tool}` };
	for (const key of schema.required) {
		if (!(key in parsed)) return { ok: false, why: `missing required "${key}"` };
	}
	for (const [key, value] of Object.entries(parsed)) {
		const type = schema.properties[key]?.type as string | undefined;
		if (!type) return { ok: false, why: `unexpected property "${key}"` };
		const actual = Number.isInteger(value) ? 'integer' : typeof value;
		if (actual !== type) return { ok: false, why: `"${key}" is ${actual}, expected ${type}` };
	}

	return { ok: true, parsed };
}

function sandboxAnswer(tool: string, input: Record<string, unknown>): string {
	const str = (key: string) => (typeof input[key] === 'string' ? input[key] : '');
	if (tool === 'Read') return SANDBOX[str('path')] ?? `Error: file not found: ${str('path')}`;
	if (tool === 'Grep') {
		const regex = new RegExp(str('pattern'));
		const hits = Object.entries(SANDBOX).flatMap(([file, text]) =>
			text
				.split('\n')
				.map((line, i) => ({ line, n: i + 1 }))
				.filter(({ line }) => regex.test(line))
				.map(({ line, n }) => `${file}:${n}:${line}`)
		);

		return hits.join('\n') || 'No matches found.';
	}
	const command = str('command');
	const file = Object.keys(SANDBOX).find((p) => command.includes(p) || command.includes(p.slice(11)));

	return file && /\b(cat|grep|head|less|sed)\b/.test(command)
		? SANDBOX[file]
		: 'Exit code: 127\nsandbox: only file reads are available';
}

const checks: Record<string, () => Promise<void>> = {
	async status() {
		const response = await api('/v1/auth/cursor/status');
		const status: { connected?: boolean } = await response.json();
		record('session status is connected', status.connected === true, JSON.stringify(status));
	},

	async models() {
		const response = await api('/v1/auth/cursor/models');
		const body: {
			models?: { id: string; toolMode?: string; imported?: boolean }[];
			error?: unknown;
		} = await response.json();
		const models = body.models ?? [];
		const grok = models.filter((m) => /^grok-4\.7-(medium|high)$/.test(m.id));
		record(
			'Cursor lists grok-4.7-medium and grok-4.7-high',
			grok.length === 2,
			body.error
				? describeError(body.error)
				: `${models.length} models; ${grok.map((m) => `${m.id} tools=${m.toolMode} imported=${m.imported}`).join(', ')}`
		);
	},

	async stream() {
		const out = await complete({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }] });
		const ok =
			out.status === 200 && out.chunks > 0 && /pong/i.test(out.text) && out.finishReason === 'stop' && out.done && !out.error;
		const shown = out.text || (out.error ? describeError(out.error) : '');
		record(
			`plain stream on ${MODEL}`,
			ok,
			`status=${out.status} chunks=${out.chunks} finish=${out.finishReason} done=${out.done} text=${JSON.stringify(shown.slice(0, 200))}`
		);
	},

	async loop() {
		const messages: Json[] = [
			{
				role: 'system',
				content: 'You are a coding agent. Use the provided tools to inspect the workspace at /workspace before answering.'
			},
			{
				role: 'user',
				content: 'What is RELEASE_CODENAME set to in this workspace? Find it with the tools, then reply with only the value.'
			}
		];
		const trail: string[] = [];
		let problem: string | null = null;
		let final: Completion | null = null;

		for (let turn = 1; turn <= 6 && !final && !problem; turn++) {
			const out = await complete({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto' });
			if (out.status !== 200 || out.error) {
				problem = `turn ${turn}: status=${out.status} error=${describeError(out.error).slice(0, 300)}`;
				break;
			}
			if (out.toolCalls.length === 0) {
				final = out;
				trail.push(`turn ${turn}: text finish=${out.finishReason}`);
				break;
			}
			if (out.finishReason !== 'tool_calls') problem = `turn ${turn}: tool calls but finish_reason=${out.finishReason}`;

			messages.push({
				role: 'assistant',
				content: out.text || null,
				tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
			});
			for (const call of out.toolCalls) {
				if (!call.id) problem = `turn ${turn}: tool call without id`;
				const check = validateArgs(call.name, call.arguments);
				if (!check.ok) problem = `turn ${turn}: ${call.name} ${check.why}`;
				const answer = check.ok ? sandboxAnswer(call.name, check.parsed) : `Error: ${check.why}`;
				trail.push(`turn ${turn}: ${call.name}(${call.arguments}) -> ${JSON.stringify(answer.slice(0, 60))}`);
				messages.push({ role: 'tool', tool_call_id: call.id, content: answer });
			}
		}

		const row = latestRequest();
		const finalText = final?.text ?? null;
		const ok = !problem && Boolean(finalText?.includes(MARKER));
		record(
			`agent loop on ${MODEL} finds the marker via tools`,
			ok,
			[
				...trail,
				problem ?? `final=${JSON.stringify(finalText?.slice(0, 200) ?? null)} expected ${MARKER}`,
				`last row: ${JSON.stringify(row)}`
			].join('\n      ')
		);
	},

	async tiers() {
		const base = MODEL.replace(/-(low|medium|high|xhigh)$/, '');
		const seen: [string, number, string | null | undefined][] = [];
		for (const effort of ['high', 'medium']) {
			const out = await complete({
				model: base,
				reasoning_effort: effort,
				messages: [{ role: 'user', content: 'Reply with: ok' }]
			});
			seen.push([effort, out.status, latestRequest()?.model]);
		}
		const ok = seen.every(([effort, status, model]) => status === 200 && model === `${base}-${effort}`);
		record(`stripped id "${base}" routes by reasoning_effort`, ok, JSON.stringify(seen));
	},

	async cancel() {
		const controller = new AbortController();
		let gotChunk = false;
		await complete(
			{ model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 400, one number per line.' }] },
			{
				signal: controller.signal,
				onChunk: () => {
					if (!gotChunk) {
						gotChunk = true;
						controller.abort();
					}
				}
			}
		).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const row = latestRequest();
		const after = await complete({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }] });
		record(
			'client cancel is recorded as aborted and the next request works',
			gotChunk && row?.stop_reason === 'aborted' && after.status === 200 && /pong/i.test(after.text),
			`gotChunk=${gotChunk} cancelledRow=${JSON.stringify(row)} next=${after.status} ${JSON.stringify(after.text.slice(0, 40))}`
		);
	}
};

console.log(`Ungate ${BASE} (api pid ${RUNTIME.api.pid}), db ${DB_PATH}, model ${MODEL}\n`);
for (const [name, run] of Object.entries(checks)) {
	if (ONLY.length && !ONLY.includes(name)) continue;
	try {
		await run();
	} catch (error) {
		record(name, false, `threw ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
