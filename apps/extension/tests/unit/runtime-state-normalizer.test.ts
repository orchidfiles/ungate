import { describe, expect, it } from 'vitest';

import { RuntimeStateDefaults } from '../../src/runtime-state/default-state';
import { RuntimeStateNormalizer } from '../../src/runtime-state/normalizer';

import type { RuntimeState } from '@ungate/shared/frontend';

function stateFile(cursorProvider: unknown): Partial<RuntimeState> {
	return { ...RuntimeStateDefaults.create(), cursorProvider } as Partial<RuntimeState>;
}

describe('RuntimeStateNormalizer cursor billing guard', () => {
	it('keeps the guard on for state files written before it existed', () => {
		expect(RuntimeStateNormalizer.normalize(stateFile({ enabled: true })).cursorProvider).toEqual({
			enabled: true,
			billingGuard: true
		});
	});

	it('keeps the guard on when the state file has no Cursor provider entry', () => {
		expect(RuntimeStateNormalizer.normalize(stateFile(undefined)).cursorProvider).toEqual({ enabled: false, billingGuard: true });
	});

	it('keeps the guard off only when the user turned it off', () => {
		expect(RuntimeStateNormalizer.normalize(stateFile({ enabled: true, billingGuard: false })).cursorProvider).toEqual({
			enabled: true,
			billingGuard: false
		});
	});
});
