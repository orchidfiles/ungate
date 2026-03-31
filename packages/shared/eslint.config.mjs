import base from '@ungate/dev-kit/eslint';

export default [
	...base,
	{
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: import.meta.dirname
			}
		}
	}
];
