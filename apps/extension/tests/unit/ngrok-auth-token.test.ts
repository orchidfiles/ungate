import { NgrokAuthToken } from '@ungate/shared';
import { describe, expect, it } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';

class MemorySecrets implements NgrokSecretStorage {
	value: string | undefined;

	constructor(initial?: string) {
		this.value = initial;
	}

	get(): Thenable<string | undefined> {
		return Promise.resolve(this.value);
	}

	store(_key: string, value: string): Thenable<void> {
		this.value = value;

		return Promise.resolve();
	}
}

describe('NgrokAuthToken.normalize', () => {
	it.each([
		['2ungateValidationFakeTokenAA_0ungateValidationFake', '2ungateValidationFakeTokenAA_0ungateValidationFake'],
		['  ungateUnitTestToken_0123456789\n', 'ungateUnitTestToken_0123456789'],
		['cr_2ungateValidationFakeToken', 'cr_2ungateValidationFakeToken']
	])('accepts the token-shaped value %s', (input, expected) => {
		expect(NgrokAuthToken.normalize(input)).toBe(expected);
	});

	it.each([
		'https://badge-bug-substances-editions.trycloudflare.com/v1',
		'https://acre-case-gibberish.ngrok-free.dev',
		'acre-case-gibberish.ngrok-free.dev',
		'ngrok config add-authtoken 2ungateValidationFakeTokenAA',
		'short',
		'',
		'   '
	])('rejects %s', (input) => {
		expect(NgrokAuthToken.normalize(input)).toBeNull();
	});

	it('rejects values that are not strings', () => {
		expect(NgrokAuthToken.normalize(undefined)).toBeNull();
		expect(NgrokAuthToken.normalize(null)).toBeNull();
		expect(NgrokAuthToken.normalize(42)).toBeNull();
	});
});

describe('NgrokTokenStore', () => {
	it('refuses to save a tunnel url as the authtoken', async () => {
		const secrets = new MemorySecrets();
		const store = new NgrokTokenStore(secrets);

		await expect(store.save('https://badge-bug-substances-editions.trycloudflare.com/v1')).rejects.toThrow(
			'That is not an ngrok authtoken'
		);
		expect(secrets.value).toBeUndefined();
	});

	it('reports a previously saved url as not set', async () => {
		const store = new NgrokTokenStore(new MemorySecrets('https://badge-bug-substances-editions.trycloudflare.com/v1'));

		const token = await store.read();
		const isSet = await store.isSet();

		expect(token).toBeNull();
		expect(isSet).toBe(false);
	});

	it('saves and reads back a trimmed token', async () => {
		const secrets = new MemorySecrets();
		const store = new NgrokTokenStore(secrets);

		await store.save('  ungateUnitTestToken_0123456789  ');

		expect(secrets.value).toBe('ungateUnitTestToken_0123456789');
		const token = await store.read();
		const isSet = await store.isSet();

		expect(token).toBe('ungateUnitTestToken_0123456789');
		expect(isSet).toBe(true);
	});

	it('still rejects an empty token with its own message', async () => {
		await expect(new NgrokTokenStore(new MemorySecrets()).save('   ')).rejects.toThrow('The ngrok authtoken is empty');
	});
});
