/**
 * `settings`: the client whose key is `app_settings.apiKey`, the key pasted into Cursor. There is
 * exactly one, with id `cursor`; it is rotated from Settings, never minted or revoked here.
 * `minted`: a key created from the Clients panel, stored only as a hash and shown once.
 */
export const CLIENT_KINDS = ['settings', 'minted'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** Safe for dashboards: never includes a key or its hash. Times are Unix milliseconds. */
export interface ClientKeyView {
	id: string;
	kind: ClientKind;
	label: string;
	createdAt: number;
	revokedAt: number | null;
}

export interface ClientKeyListResponse {
	clients: ClientKeyView[];
}

export interface ClientKeyCreateRequest {
	label: string;
}

/** The only response that carries a key; it is not retrievable afterwards. */
export interface ClientKeyCreateResponse {
	client: ClientKeyView;
	key: string;
	clients: ClientKeyView[];
}

/** `GET /v1/client`: the presented key's client; `null` when the model routes are open. */
export interface WhoAmIResponse {
	client: { id: string; label: string } | null;
}

/** Requests and tokens per client over an analytics period. */
export interface ClientUsage {
	/** `null` groups requests recorded without a client (before clients existed, or with auth off). */
	clientId: string | null;
	label: string | null;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	errors: number;
	lastRequestAt: number | null;
}
