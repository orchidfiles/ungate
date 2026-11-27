export interface RequestPacerOptions {
	/** Runs allowed in flight at once per key. */
	maxConcurrent: number;
	/** Minimum gap between two run starts on the same key. */
	minIntervalMs: number;
	/** A queued request fails with `PacerTimeoutError` after waiting this long. */
	maxWaitMs: number;
	now?: () => number;
}

export class PacerTimeoutError extends Error {
	constructor() {
		super('Timed out waiting for a Cursor request slot');
		this.name = 'PacerTimeoutError';
	}
}

export class PacerAbortError extends Error {
	constructor() {
		super('aborted');
		this.name = 'PacerAbortError';
	}
}

export type PacerRelease = () => void;

interface Waiter {
	grant: (release: PacerRelease) => void;
}

interface Lane {
	active: number;
	nextStartAt: number;
	waiters: Waiter[];
	timer: NodeJS.Timeout | null;
}

/**
 * Keeps traffic to one upstream key (a Cursor model) inside its rate limits: at most
 * `maxConcurrent` runs in flight, starts spaced by `minIntervalMs`, FIFO order, and a
 * `penalize` hook that pushes every later start out after the upstream reports a rate limit.
 */
export class RequestPacer {
	private readonly lanes = new Map<string, Lane>();
	private readonly now: () => number;

	constructor(private readonly options: RequestPacerOptions) {
		this.now = options.now ?? Date.now;
	}

	acquire(key: string, signal?: AbortSignal): Promise<PacerRelease> {
		if (signal?.aborted) return Promise.reject(new PacerAbortError());
		const lane = this.lane(key);

		return new Promise<PacerRelease>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				signal?.removeEventListener('abort', onAbort);
			};
			const drop = (error: Error) => {
				const index = lane.waiters.indexOf(waiter);
				if (index === -1) return;
				lane.waiters.splice(index, 1);
				cleanup();
				reject(error);
				this.pump(key, lane);
			};
			const onAbort = () => drop(new PacerAbortError());
			const timeout = setTimeout(() => drop(new PacerTimeoutError()), this.options.maxWaitMs);
			const waiter: Waiter = {
				grant: (release) => {
					cleanup();
					resolve(release);
				}
			};

			signal?.addEventListener('abort', onAbort, { once: true });
			lane.waiters.push(waiter);
			this.pump(key, lane);
		});
	}

	/** Holds back every start on `key` for at least `delayMs` from now. */
	penalize(key: string, delayMs: number): void {
		const lane = this.lane(key);
		lane.nextStartAt = Math.max(lane.nextStartAt, this.now() + delayMs);
	}

	/** Exposed for tests and diagnostics. */
	snapshot(key: string): { active: number; queued: number } {
		const lane = this.lanes.get(key);

		return { active: lane?.active ?? 0, queued: lane?.waiters.length ?? 0 };
	}

	private lane(key: string): Lane {
		let lane = this.lanes.get(key);
		if (!lane) {
			lane = { active: 0, nextStartAt: 0, waiters: [], timer: null };
			this.lanes.set(key, lane);
		}

		return lane;
	}

	private pump(key: string, lane: Lane): void {
		if (lane.timer) {
			clearTimeout(lane.timer);
			lane.timer = null;
		}

		while (lane.waiters.length > 0 && lane.active < this.options.maxConcurrent) {
			const wait = lane.nextStartAt - this.now();
			if (wait > 0) {
				lane.timer = setTimeout(() => {
					lane.timer = null;
					this.pump(key, lane);
				}, wait);

				return;
			}

			const waiter = lane.waiters.shift()!;
			lane.active += 1;
			lane.nextStartAt = this.now() + this.options.minIntervalMs;
			waiter.grant(this.releaser(key, lane));
		}

		if (lane.active === 0 && lane.waiters.length === 0 && lane.nextStartAt <= this.now()) {
			this.lanes.delete(key);
		}
	}

	private releaser(key: string, lane: Lane): PacerRelease {
		let released = false;

		return () => {
			if (released) return;
			released = true;
			lane.active -= 1;
			this.pump(key, lane);
		};
	}
}
