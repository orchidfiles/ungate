import baseConfig from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default mergeConfig(baseConfig, {
	plugins: [tsconfigPaths()],
	test: {
		dir: 'tests/integration',
		fileParallelism: false,
		include: ['tests/integration/**/*.test.ts'],
		setupFiles: ['tests/integration/vitest.setup.ts'],
		globalSetup: ['tests/integration/global-setup.ts'],
		server: {
			deps: {
				external: ['better-sqlite3']
			}
		}
	}
});
