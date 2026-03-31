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

	rareError(errorMessage: string, context: Record<string, unknown>): void {
		globalThis.console.error(`[RARE ERROR] ${errorMessage}`);
		globalThis.console.error(JSON.stringify(context, null, 2));
	}
};
