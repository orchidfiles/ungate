export type AIProviderName = 'claude' | 'minimax' | 'openai';

export interface OAuthCredentials {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: number | null;
	email?: string | null;
	accountId?: string | null;
}

/** Every member is async: credentials live in the extension secret store, one IPC hop away. */
export interface AIProvider {
	readonly name: AIProviderName;
	getAuthHeader(): Promise<string | null>;
	isAuthenticated(): Promise<boolean>;
	logout(): Promise<void>;
}
