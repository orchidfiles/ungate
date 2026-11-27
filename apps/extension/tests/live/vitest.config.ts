import base from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(base, {
	test: {
		dir: 'tests/live',
		fileParallelism: false,
		passWithNoTests: false
	}
});
