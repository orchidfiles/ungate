import baseConfig from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default mergeConfig(baseConfig, {
	plugins: [tsconfigPaths()],
	test: {
		dir: 'tests/unit',
		server: {
			deps: {
				external: ['better-sqlite3']
			}
		}
	}
});
