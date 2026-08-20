// Administrative routes (settings, provider auth, analytics) are gated by a key that is
// separate from the proxy API key Cursor uses. The extension mints it per install and
// keeps it in VS Code SecretStorage, so it never reaches the SQLite settings table.
export const ADMIN_KEY_HEADER = 'x-ungate-admin-key';

export const ADMIN_KEY_ENV = 'UNGATE_ADMIN_KEY';

/** VS Code SecretStorage key holding the administrative API key the extension mints per install. */
export const ADMIN_KEY_SECRET_KEY = 'ungate.admin-api-key';

// A 256-bit key is 43 characters base64url-encoded and 64 characters hex-encoded.
// Anything shorter than the base64url length cannot carry 256 bits of entropy.
export const ADMIN_KEY_MIN_LENGTH = 43;

export const DEFAULT_KEY_FIX_ENABLED = false;

export const MINIMAX_BASE_URLS = {
	global: 'https://api.minimax.io',
	china: 'https://api.minimaxi.com'
} as const;
