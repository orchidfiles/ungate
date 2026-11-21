import { config } from 'src/config';

import { OpenAIOAuthUtils } from '../openai/openai-oauth-utils';

export class GeminiOAuthUtils {
	public static generatePkce(): Promise<{ verifier: string; challenge: string }> {
		return OpenAIOAuthUtils.generatePkce();
	}

	/** Successful sign-ins redirect to Google's own Gemini success page, like gemini-cli. */
	public static successRedirect(): string {
		return config.gemini.oauth.successUrl;
	}

	public static callbackPage(ok: boolean, error?: string): string {
		return OpenAIOAuthUtils.callbackPage(ok, error);
	}
}
