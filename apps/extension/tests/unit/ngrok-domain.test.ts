import { NgrokDomain } from '@ungate/shared';
import { describe, expect, it } from 'vitest';

describe('NgrokDomain.normalize', () => {
	it.each([
		['api.example.com', 'api.example.com'],
		['  API.Example.COM  ', 'api.example.com'],
		['my-app.ngrok.app', 'my-app.ngrok.app'],
		['a.b.c.example.io', 'a.b.c.example.io'],
		['example.com.', 'example.com'],
		['xn--80aswg.xn--p1ai', 'xn--80aswg.xn--p1ai']
	])('accepts the hostname %s', (input, expected) => {
		expect(NgrokDomain.normalize(input)).toBe(expected);
	});

	it.each([
		'',
		'   ',
		'https://api.example.com',
		'api.example.com/v1',
		'api.example.com:443',
		'user@example.com',
		'localhost',
		'example',
		'-bad.example.com',
		'bad-.example.com',
		'bad..example.com',
		'exa mple.com',
		'example.com --config /tmp/x',
		'--url=evil.example.com',
		'*.example.com',
		'example.c',
		'127.0.0.1',
		`${'a'.repeat(64)}.example.com`,
		`${'a.'.repeat(130)}com`
	])('rejects %j', (input) => {
		expect(NgrokDomain.normalize(input)).toBeNull();
	});

	it.each([null, undefined, 42, {}, ['api.example.com']])('rejects the non-string %j', (input) => {
		expect(NgrokDomain.normalize(input)).toBeNull();
	});
});
