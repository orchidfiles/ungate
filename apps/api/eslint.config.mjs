import base from '@ungate/dev-kit/eslint';

export default [
	...base,
	{
		settings: {
			'import-x/internal-regex': '^(@ungate|src)(/|$)',
			'import-x/resolver': { typescript: { project: './tsconfig.json' } }
		},
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: import.meta.dirname
			}
		}
	}
];
