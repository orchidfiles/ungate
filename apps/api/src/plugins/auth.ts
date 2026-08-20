import { createHash, timingSafeEqual } from 'node:crypto';

import { ADMIN_KEY_HEADER } from '@ungate/shared';

import type { Config } from '../config';
import type { onRequestAsyncHookHandler } from 'fastify';

const BEARER_PREFIX = 'Bearer ';

/**
 * Compares two secrets without leaking their contents or length through timing.
 * Hashing first equalises the buffer length, which `timingSafeEqual` requires and
 * which a raw length check would otherwise reveal. An absent or empty `expected`
 * never matches, so an unconfigured key locks the route instead of opening it.
 */
function secretsMatch(provided: string | undefined, expected: string | undefined): boolean {
	if (provided === undefined || expected === undefined || expected.length === 0) return false;

	const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
	const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();

	return timingSafeEqual(providedDigest, expectedDigest);
}

/** Duplicate headers arrive as arrays; treat them as absent rather than guessing which one counts. */
function singleHeader(raw: string | string[] | undefined): string | undefined {
	return typeof raw === 'string' ? raw : undefined;
}

/**
 * Proxy-key auth for the routes Cursor calls: both completion endpoints and the model list.
 * Cursor sends the key as `Authorization: Bearer <key>` or `x-api-key`.
 *
 * Fails closed when no proxy key is configured. These routes are reachable through the public
 * tunnel, so an absent key must lock them down rather than open them to anyone holding the URL.
 * `Settings.get()` mints a key on first run; blanking it in the dashboard therefore disables the
 * proxy until a new one is set.
 */
export function apiKeyAuth(config: Config): onRequestAsyncHookHandler {
	return async (request, reply) => {
		const authorization = singleHeader(request.headers.authorization);
		const bearer = authorization?.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length) : undefined;
		const key = bearer ?? singleHeader(request.headers['x-api-key']);

		if (!secretsMatch(key, config.apiKey)) {
			return reply
				.code(403)
				.send({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized: Invalid API key' } });
		}
	};
}

/**
 * Admin-key auth for every administrative route (settings, provider auth, analytics).
 * Distinct from the proxy key so that exposing the tunnel URL to Cursor never grants
 * control over provider credentials or local settings. Fails closed when unconfigured.
 */
export function adminKeyAuth(config: Config): onRequestAsyncHookHandler {
	return async (request, reply) => {
		const key = singleHeader(request.headers[ADMIN_KEY_HEADER]);

		if (!secretsMatch(key, config.adminApiKey)) {
			return reply
				.code(403)
				.send({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized: Invalid admin key' } });
		}
	};
}
