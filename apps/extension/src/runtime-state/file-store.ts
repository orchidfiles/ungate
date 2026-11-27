import * as fs from 'node:fs';

import { type RuntimeState } from '@ungate/shared/frontend';

import { CrossProcessLock } from '../utils/cross-process-lock';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';
import { RuntimeStateNormalizer } from './normalizer';

const RUNTIME_STATE_LOCK = 'runtime-state.lock';

export class RuntimeStateFileStore {
	public static read(): RuntimeState {
		this.ensureStorage();
		const fallback = RuntimeStateDefaults.create();

		if (!fs.existsSync(config.paths.stateFilePath)) {
			return fallback;
		}

		try {
			const raw = fs.readFileSync(config.paths.stateFilePath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<RuntimeState>;

			return RuntimeStateNormalizer.normalize(parsed);
		} catch {
			return fallback;
		}
	}

	public static write(next: RuntimeState): void {
		this.ensureStorage();
		const temp = `${config.paths.stateFilePath}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
		fs.renameSync(temp, config.paths.stateFilePath);
	}

	public static async mutate(mutator: (current: RuntimeState) => RuntimeState | Promise<RuntimeState>): Promise<RuntimeState> {
		this.ensureStorage();
		const release = await CrossProcessLock.acquire(RUNTIME_STATE_LOCK);

		try {
			const current = this.read();
			const next = await mutator(current);
			this.write(next);

			return next;
		} finally {
			release();
		}
	}

	public static getFilePath(): string {
		return config.paths.stateFilePath;
	}

	private static ensureStorage(): void {
		fs.mkdirSync(config.baseDir, { recursive: true });
	}
}
