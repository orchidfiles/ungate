import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import vitest from '@vitest/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import eslintPluginImportX from 'eslint-plugin-import-x';
import prettier from 'eslint-plugin-prettier';
import globals from 'globals';
import { createRequire } from 'node:module';
import tseslint from 'typescript-eslint';

import { noAwaitInParens } from './eslint-rules/no-await-in-parens.mjs';

const require = createRequire(import.meta.url);

export const prettierPluginTailwindcssPath = require.resolve('prettier-plugin-tailwindcss');
export const prettierPluginSveltePath = require.resolve('prettier-plugin-svelte');

/**
 * @typedef {import('prettier').Options} PrettierOptions
 * @typedef {import('eslint').Linter.Config} EslintConfig
 */

export const defaultIgnores = ['dist', 'lib', 'coverage', 'node_modules', 'tmp', '*.json'];

const resolverSettings = {
	'import-x/resolver-next': [
		createTypeScriptImportResolver({
			alwaysTryTypes: true,
			extensions: ['.ts', '.js', '.mjs', '.d.ts', '.json']
		})
	]
};

/** @type {PrettierOptions} */
export const prettierOptions = {
	htmlWhitespaceSensitivity: 'strict',
	bracketSameLine: true,
	singleAttributePerLine: true,
	singleQuote: true,
	trailingComma: 'none',
	bracketSpacing: true,
	printWidth: 130,
	tabWidth: 2,
	useTabs: true,
	semi: true,
	quoteProps: 'as-needed',
	endOfLine: 'auto',
	arrowParens: 'always'
};

/** @type {EslintConfig['rules']} */
export const rules = {
	'prettier/prettier': ['error', prettierOptions],

	'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
	'no-implicit-globals': ['error'],

	'padding-line-between-statements': [
		'error',
		{ blankLine: 'always', prev: '*', next: 'return' },
		{ blankLine: 'always', prev: 'import', next: '*' },
		{ blankLine: 'any', prev: 'import', next: 'import' }
	],

	'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
	'@typescript-eslint/no-empty-function': 'off',
	'@typescript-eslint/no-unsafe-return': 'off',
	'@typescript-eslint/no-unsafe-assignment': 'off',
	'@typescript-eslint/no-unsafe-argument': 'off',

	'@stylistic/no-multiple-empty-lines': ['error', { max: 0, maxBOF: 0, maxEOF: 0 }],
	'@stylistic/lines-between-class-members': [
		'error',
		'always',
		{
			exceptAfterOverload: true,
			exceptAfterSingleLine: true
		}
	],
	'@stylistic/max-len': [
		'error',
		{
			code: 130,
			tabWidth: 2,
			ignoreUrls: true,
			ignoreComments: false,
			ignoreTrailingComments: true,
			ignoreStrings: true,
			ignoreTemplateLiterals: true,
			ignoreRegExpLiterals: true
		}
	],
	'@stylistic/multiline-comment-style': 'off',
	'@stylistic/no-extra-parens': ['error', 'all', { nestedBinaryExpressions: false, enforceForArrowConditionals: false }]
};

/** @type {EslintConfig['languageOptions']} */
const languageOptions = {
	parser: tsParser,
	parserOptions: {
		projectService: true,
		tsconfigRootDir: import.meta.dirname
	},
	globals: {
		...globals.node
	},
	ecmaVersion: 'latest',
	sourceType: 'module'
};

/** @type {EslintConfig['rules']} */
export const rulesImport = {
	'import-x/no-named-as-default-member': 'off',
	'import-x/no-unresolved': 'error',
	'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
	'import-x/namespace': ['warn', { allowComputed: true }],
	'import-x/order': [
		'error',
		{
			'newlines-between': 'always',
			groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
			alphabetize: {
				order: 'asc',
				caseInsensitive: true
			}
		}
	]
};

export default defineConfig(
	tseslint.configs.recommendedTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	eslintPluginImportX.flatConfigs.recommended,
	eslintPluginImportX.flatConfigs.typescript,
	stylistic.configs.all,
	globalIgnores(defaultIgnores),
	{
		plugins: { prettier, vitest, local: { rules: { 'no-await-in-parens': noAwaitInParens } } },
		files: ['**/*.{ts,js,mjs}'],
		settings: resolverSettings,
		languageOptions,
		rules: {
			...rules,
			...rulesImport,
			...vitest.configs.recommended.rules,

			'vitest/no-commented-out-tests': 'off',
			'vitest/valid-title': 'off',
			'vitest/max-nested-describe': ['error', { max: 3 }],

			'local/no-await-in-parens': 'error'
		}
	},
	{
		files: ['tests/**/*.ts'],
		rules: {
			'vitest/no-standalone-expect': 'off',
			'vitest/expect-expect': 'off',
			'vitest/max-nested-describe': 'off'
		}
	},
	eslintConfigPrettier
);
