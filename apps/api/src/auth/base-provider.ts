export type AIProviderName = 'claude' | 'minimax' | 'openai';

export interface OAuthCredentials {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: number | null;
	email?: string | null;
	accountId?: string | null;
}

export interface AIProvider {
	readonly name: AIProviderName;
	getAuthHeader(): string | null | Promise<string | null>;
	isAuthenticated(): boolean;
	logout(): void;
}
