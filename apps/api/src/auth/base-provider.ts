export type AIProviderName = 'claude' | 'minimax';

export interface OAuthCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	email?: string;
}

export interface AIProvider {
	readonly name: AIProviderName;
	getAuthHeader(): string | null | Promise<string | null>;
	isAuthenticated(): boolean;
	logout(): void;
}
