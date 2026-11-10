import { describe, expect, it } from 'vitest';

import { ClaudeCliVersion } from '@ungate/shared';

describe('ClaudeCliVersion', () => {
	it('formats User-Agent like Claude Code OAuth client', () => {
		expect(ClaudeCliVersion.formatUserAgent('2.1.280')).toBe('claude-cli/2.1.280 (external, claude-vscode)');
	});

	it('resolves stable, latest, and custom versions', () => {
		expect(ClaudeCliVersion.resolve('stable', null)).toBe('2.1.9');
		expect(ClaudeCliVersion.resolve('latest', null)).toBe('2.1.322');
		expect(ClaudeCliVersion.resolve('custom', '2.1.280')).toBe('2.1.280');
	});

	it('falls back to stable for invalid custom version', () => {
		expect(ClaudeCliVersion.resolve('custom', 'not-a-version')).toBe('2.1.9');
		expect(ClaudeCliVersion.resolve('custom', null)).toBe('2.1.9');
	});

	it('validates version strings', () => {
		expect(ClaudeCliVersion.isVersionString('2.1.280')).toBe(true);
		expect(ClaudeCliVersion.isVersionString('2.1')).toBe(false);
		expect(ClaudeCliVersion.isVersionString('v2.1.280')).toBe(false);
	});

	it('returns error message for invalid custom version input', () => {
		expect(ClaudeCliVersion.validateCustomVersion('')).toMatch(/2\.1\.280/);
		expect(ClaudeCliVersion.validateCustomVersion('2.1.280')).toBeNull();
	});
});
