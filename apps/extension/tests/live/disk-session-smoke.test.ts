// Live smoke test (not part of CI): builds credentials from Cursor's on-disk session and lists
// models. From apps/extension:
//   CURSOR_LIVE=1 node_modules/.bin/vitest run tests/live/disk-session-smoke.test.ts
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CursorDiskSession } from '../../src/cursor/cursor-disk-session';
import { CursorSession } from '../../src/cursor/cursor-session';
import { fetchUsableModels } from '../../src/cursor/models';
import { runInference } from '../../src/cursor/run-inference';
import { createStateDbItemReader } from '../../src/cursor/state-db-item-reader';

const dir = path.join(os.homedir(), '.config/Cursor/User/globalStorage');

describe.runIf(process.env.CURSOR_LIVE === '1')('live Cursor disk session', () => {
	it('lists models with disk credentials', async () => {
		const readItem = createStateDbItemReader();
		expect(readItem).not.toBeNull();
		const disk = new CursorDiskSession({
			stateDbPath: path.join(dir, 'state.vscdb'),
			storageJsonPath: path.join(dir, 'storage.json'),
			cursorVersion: process.env.CURSOR_VERSION ?? '3.29.9',
			readItem: readItem!
		});
		const session = new CursorSession(undefined, disk);
		const signedIn = await session.ensureSignedIn();
		expect(signedIn).toBe(true);
		const creds = session.credentials();
		expect(creds).not.toBeNull();
		const models = await fetchUsableModels(creds!);
		console.log(`membership=${session.membershipType()} models=${models.length}`);
		console.log(models.filter((m) => m.id.includes('grok')).map((m) => `${m.id} thinking=${m.thinking} tools=${m.toolMode}`));
		expect(models.length).toBeGreaterThan(0);

		const modelId = process.env.CURSOR_MODEL ?? 'grok-4.7-medium';
		let text = '';
		let end: unknown;
		for await (const event of runInference({
			request: {
				modelId,
				messages: [{ role: 'INFERENCE_MESSAGE_ROLE_USER', text: 'Reply with exactly: PONG' }],
				tools: []
			},
			credentials: () => session.credentials(),
			refresh: () => session.refresh(),
			signal: new AbortController().signal
		})) {
			if (event.kind === 'text') text += event.text;
			if (event.kind === 'end') end = event;
		}
		console.log(`inference model=${modelId} text=${JSON.stringify(text.slice(0, 80))} end=${JSON.stringify(end)}`);
		expect(text).toContain('PONG');
	}, 90_000);
});
