let quietMode = false;

export function setQuietMode(enabled: boolean): void {
	quietMode = enabled;
}

export const logger = {
	log(...args: unknown[]): void {
		if (!quietMode) {
			globalThis.console.log(...args);
		}
	},

	warn(...args: unknown[]): void {
		if (!quietMode) {
			globalThis.console.warn(...args);
		}
	},

	error(...args: unknown[]): void {
		globalThis.console.error(...args);
	},

	/**
	 * One JSON line for a state change an operator watches (e.g. an account needing sign-in), so it
	 * reaches the service journal whatever quiet mode says.
	 */
	event(name: string, fields: Record<string, string | number | null>): void {
		globalThis.console.log(JSON.stringify({ event: name, ...fields }));
	},

	rareError(errorMessage: string, context: Record<string, unknown>): void {
		globalThis.console.error(`[RARE ERROR] ${errorMessage}`);
		globalThis.console.error(JSON.stringify(context, null, 2));
	}
};
