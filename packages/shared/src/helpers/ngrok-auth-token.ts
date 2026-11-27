/**
 * A user-supplied ngrok authtoken. ngrok does not publish the token format, so this only rejects
 * input that cannot be one: a pasted URL or hostname (the tunnel base URL sits on the clipboard
 * right next to this field), or anything with whitespace.
 */
export class NgrokAuthToken {
	private static readonly minLength = 16;
	private static readonly impossiblePattern = /[\s/:.]/;

	/** Returns the trimmed token, or null when the input cannot be an ngrok authtoken. */
	public static normalize(input: unknown): string | null {
		if (typeof input !== 'string') {
			return null;
		}

		const token = input.trim();

		if (token.length < this.minLength || this.impossiblePattern.test(token)) {
			return null;
		}

		return token;
	}
}
