import type { LogLevel } from '@ungate/shared/frontend';

export interface NgrokFailure {
	code: string | null;
	message: string | null;
}

interface NgrokJsonFields {
	lvl?: unknown;
	msg?: unknown;
	url?: unknown;
	err?: unknown;
}

const ERROR_CODE_PATTERN = /ERR_NGROK_\d+/;
const PLAIN_ERROR_PREFIX = /^ERROR:\s*/;
const TUNNEL_STARTED_MESSAGE = 'started tunnel';
const NGROK_OWN_HOST_PATTERN = /(^|\.)(ngrok\.com|ngrok-agent\.com)$/;
const ERROR_LEVELS: ReadonlySet<string> = new Set(['eror', 'error', 'crit']);
const WARN_LEVELS: ReadonlySet<string> = new Set(['warn', 'warning']);

/**
 * One line of `ngrok http --log stdout --log-format json` output. stdout carries JSON objects
 * (levels `info`, `warn`, `eror`, `crit`); stderr carries plain `ERROR:  ...` lines even in JSON mode.
 *
 * ngrok's error text links to its own site (`https://dashboard.ngrok.com/...`), so the tunnel URL
 * is taken only from the `url` field of the `started tunnel` event, never from free text.
 */
export class NgrokLogLine {
	readonly level: LogLevel;
	readonly tunnelUrl: string | null;
	readonly failure: NgrokFailure | null;

	constructor(line: string) {
		const trimmed = line.trim();
		const fields = this.parseJson(trimmed);

		if (fields) {
			const level = typeof fields.lvl === 'string' ? fields.lvl.toLowerCase() : '';
			const isError = ERROR_LEVELS.has(level);

			this.level = this.mapLevel(level);
			this.tunnelUrl = isError || fields.msg !== TUNNEL_STARTED_MESSAGE ? null : this.readTunnelUrl(fields.url);
			this.failure = isError && typeof fields.err === 'string' ? this.readFailure(fields.err) : null;

			return;
		}

		const isPlainError = PLAIN_ERROR_PREFIX.test(trimmed);

		this.level = isPlainError ? 'error' : 'info';
		this.tunnelUrl = null;
		this.failure = isPlainError ? this.readFailure(trimmed.replace(PLAIN_ERROR_PREFIX, '')) : null;
	}

	private parseJson(trimmed: string): NgrokJsonFields | null {
		if (!trimmed.startsWith('{')) {
			return null;
		}

		try {
			const parsed: unknown = JSON.parse(trimmed);

			return typeof parsed === 'object' && parsed !== null ? parsed : null;
		} catch {
			return null;
		}
	}

	private mapLevel(level: string): LogLevel {
		if (ERROR_LEVELS.has(level)) {
			return 'error';
		}

		return WARN_LEVELS.has(level) ? 'warn' : 'info';
	}

	private readTunnelUrl(value: unknown): string | null {
		if (typeof value !== 'string') {
			return null;
		}

		try {
			const url = new URL(value);

			if (url.protocol !== 'https:' || NGROK_OWN_HOST_PATTERN.test(url.hostname)) {
				return null;
			}

			return url.origin;
		} catch {
			return null;
		}
	}

	/** The first text line that is neither a link nor the error code is the human-readable reason. */
	private readFailure(text: string): NgrokFailure | null {
		const code = ERROR_CODE_PATTERN.exec(text)?.[0] ?? null;
		const message =
			text
				.split(/\r?\n/)
				.map((part) => part.trim())
				.find((part) => part.length > 0 && !/^https?:\/\//i.test(part) && !/^ERR_NGROK_\d+$/.test(part)) ?? null;

		return code === null && message === null ? null : { code, message };
	}
}
