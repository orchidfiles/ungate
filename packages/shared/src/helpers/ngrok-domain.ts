/** A user-supplied ngrok domain: a bare hostname, never a URL. */
export class NgrokDomain {
	private static readonly maxLength = 253;
	private static readonly hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

	/** Returns the lowercase hostname, or null when the input is not a plain hostname. */
	public static normalize(input: unknown): string | null {
		if (typeof input !== 'string') {
			return null;
		}

		const hostname = input.trim().toLowerCase().replace(/\.$/, '');

		if (hostname.length === 0 || hostname.length > this.maxLength) {
			return null;
		}

		return this.hostnamePattern.test(hostname) ? hostname : null;
	}
}
