const NGROK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*/i;

/** ngrok prints the stable dev-domain URL in its JSON log and in plain text. */
export class NgrokUrl {
	static read(line: string): string | null {
		const trimmed = line.trim();

		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed) as { url?: unknown; msg?: unknown };
				const direct = typeof parsed.url === 'string' ? parsed.url : null;
				const fromMessage = typeof parsed.msg === 'string' ? NGROK_URL_PATTERN.exec(parsed.msg)?.[0] : null;

				return NgrokUrl.normalize(direct ?? fromMessage ?? null);
			} catch {
				return null;
			}
		}

		return NgrokUrl.normalize(NGROK_URL_PATTERN.exec(trimmed)?.[0] ?? null);
	}

	private static normalize(value: string | null): string | null {
		if (!value) {
			return null;
		}

		try {
			const url = new URL(value);

			return url.protocol === 'https:' ? url.origin : null;
		} catch {
			return null;
		}
	}
}
