export interface AuthStatus {
	authenticated: boolean;
	email?: string;
}

export interface LoginStart {
	authUrl: string;
	sessionId: string;
}
