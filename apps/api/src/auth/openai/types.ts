export interface CodexAuthInfo {
	chatgpt_account_id: string;
	chatgpt_plan_type: string;
	chatgpt_user_id: string;
	user_id: string;
	organizations: {
		id: string;
		is_default: boolean;
		role: string;
		title: string;
	}[];
}

export interface PkceSession {
	codeVerifier: string;
	state: string;
	expiresAt: number;
}
