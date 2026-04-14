import type { CodexAuthInfo } from './types';

export class OpenAIOAuthUtils {
	public static parseIdToken(idToken: string): { email: string | null; authInfo: CodexAuthInfo | null } {
		try {
			const parts = idToken.split('.');

			if (parts.length !== 3) {
				return { email: null, authInfo: null };
			}

			const decoded = JSON.parse(this.decodeBase64(parts[1])) as Record<string, unknown>;
			const email = typeof decoded.email === 'string' ? decoded.email : null;
			const authInfoRecord = decoded['https://api.openai.com/auth'] as CodexAuthInfo | undefined;

			return { email, authInfo: authInfoRecord ?? null };
		} catch {
			return { email: null, authInfo: null };
		}
	}

	public static resolveWorkspace(authInfo: CodexAuthInfo | null): string | null {
		if (!authInfo) {
			return null;
		}

		let workspaceId = authInfo.chatgpt_account_id || null;
		const planType = (authInfo.chatgpt_plan_type || '').toLowerCase();
		const organizations = authInfo.organizations || [];

		if (organizations.length > 0) {
			const teamOrganization = organizations.find((organization) => {
				const title = (organization.title || '').toLowerCase();
				const role = (organization.role || '').toLowerCase();

				return (
					!organization.is_default &&
					(title.includes('team') ||
						title.includes('business') ||
						title.includes('workspace') ||
						title.includes('org') ||
						role === 'admin' ||
						role === 'member')
				);
			});

			if (planType.includes('team') || planType.includes('chatgptteam')) {
				return workspaceId;
			}

			if (teamOrganization && (planType === 'free' || planType === '')) {
				workspaceId = teamOrganization.id;
			}
		}

		return workspaceId;
	}

	public static base64urlEncode(buffer: Buffer): string {
		return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	public static async generatePkce(): Promise<{ verifier: string; challenge: string }> {
		const verifier = this.base64urlEncode(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
		const encoder = new TextEncoder();
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
		const challenge = this.base64urlEncode(Buffer.from(digest));

		return { verifier, challenge };
	}

	private static decodeBase64(input: string): string {
		let base64 = input;

		switch (base64.length % 4) {
			case 2:
				base64 += '==';
				break;
			case 3:
				base64 += '=';
				break;
		}

		base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);

		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}

		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}
}
