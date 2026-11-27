import { describe, expect, it } from 'vitest';

import { TunnelHostnameScreen } from '../../src/tunnel-hostname-screen';
import { TUNNEL_HOSTNAME_BLOCKED_WORDS } from '../../src/tunnel-hostname-words';

const OBSERVED_CLEAN_HOSTNAMES = [
	'abraham-roster-manuals-shortcuts',
	'sum-accept-exchanges-hartford',
	'acre-case-gibberish',
	'separated-nation-divisions-shaw',
	'table-tee-defines-customs',
	'sheffield-range-seeds-why',
	'equipment-standard-lyric-wrestling',
	'corrected-gone-gps-ties',
	'conviction-beauty-earning-regardless'
];

describe('TunnelHostnameScreen.isAcceptable', () => {
	it.each(OBSERVED_CLEAN_HOSTNAMES)('accepts the ordinary hostname %s', (label) => {
		expect(TunnelHostnameScreen.isAcceptable(`https://${label}.trycloudflare.com`)).toBe(true);
		expect(TunnelHostnameScreen.isAcceptable(`https://${label}.ngrok-free.dev`)).toBe(true);
	});

	it.each(['stupid', 'idiot', 'ugly', 'worthless', 'loser', 'shit', 'slut'])(
		'rejects a hostname with the whole token %s',
		(word) => {
			expect(TunnelHostnameScreen.isAcceptable(`https://table-${word}-range-seeds.trycloudflare.com`)).toBe(false);
			expect(TunnelHostnameScreen.isAcceptable(`https://${word}-case-acre.ngrok-free.dev`)).toBe(false);
			expect(TunnelHostnameScreen.isAcceptable(`https://acre-case-${word}.ngrok-free.app`)).toBe(false);
		}
	);

	it('matches whole tokens only, so words that contain a blocked substring pass', () => {
		for (const label of [
			'assessment-classic-passage',
			'scunthorpe-essex-sussex',
			'cocktail-analysis-therapist',
			'button-dickens-title'
		]) {
			expect(TunnelHostnameScreen.isAcceptable(`https://${label}.trycloudflare.com`)).toBe(true);
		}
	});

	it('ignores letter case and accepts a bare hostname', () => {
		expect(TunnelHostnameScreen.isAcceptable('https://Table-STUPID-range.trycloudflare.com')).toBe(false);
		expect(TunnelHostnameScreen.isAcceptable('table-stupid-range.trycloudflare.com')).toBe(false);
		expect(TunnelHostnameScreen.isAcceptable('table-tee-range.trycloudflare.com')).toBe(true);
	});

	it('screens only the first label, not the provider domain or path', () => {
		expect(TunnelHostnameScreen.isAcceptable('https://table-tee.stupid.example.com/ugly-path')).toBe(true);
	});

	it('accepts input that is not a hostname', () => {
		expect(TunnelHostnameScreen.isAcceptable('')).toBe(true);
		expect(TunnelHostnameScreen.isAcceptable('https://')).toBe(true);
	});
});

describe('TunnelHostnameScreen.redact', () => {
	it('hides a rejected quick-tunnel hostname inside provider output', () => {
		const line = '2026-11-23T00:00:00Z INF |  https://table-stupid-range-seeds.trycloudflare.com  |';
		const errorLine = 'ERR error="timeout" dest=https://table-stupid-range-seeds.trycloudflare.com/v1/chat/completions';

		expect(TunnelHostnameScreen.redact(line)).toBe('2026-11-23T00:00:00Z INF |  https://hidden-hostname.trycloudflare.com  |');
		expect(TunnelHostnameScreen.redact(errorLine)).toBe(
			'ERR error="timeout" dest=https://hidden-hostname.trycloudflare.com/v1/chat/completions'
		);
	});

	it('hides a rejected ngrok hostname inside a json log line', () => {
		expect(TunnelHostnameScreen.redact('{"msg":"started tunnel","url":"https://acre-idiot-case.ngrok-free.dev"}')).toBe(
			'{"msg":"started tunnel","url":"https://hidden-hostname.ngrok-free.dev"}'
		);
	});

	it('leaves accepted hostnames and unrelated text untouched', () => {
		const line = 'INF |  https://table-tee-defines-customs.trycloudflare.com  | stupid origin error';

		expect(TunnelHostnameScreen.redact(line)).toBe(line);
	});
});

describe('tunnel hostname word list', () => {
	it('holds unique whole lowercase tokens', () => {
		expect(new Set(TUNNEL_HOSTNAME_BLOCKED_WORDS).size).toBe(TUNNEL_HOSTNAME_BLOCKED_WORDS.length);

		for (const word of TUNNEL_HOSTNAME_BLOCKED_WORDS) {
			expect(word).toMatch(/^[a-z]+$/);
		}
	});

	it('contains none of the tokens from hostnames observed in normal use', () => {
		const tokens = OBSERVED_CLEAN_HOSTNAMES.flatMap((label) => label.split('-'));

		expect(tokens.filter((token) => TUNNEL_HOSTNAME_BLOCKED_WORDS.includes(token))).toEqual([]);
	});
});
