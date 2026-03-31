import html from '@html-eslint/eslint-plugin';
import pluginQuery from '@tanstack/eslint-plugin-query';
import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import eslintPluginImportX from 'eslint-plugin-import-x';
import prettier from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import sortClassMembers from 'eslint-plugin-sort-class-members';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tseslint from 'typescript-eslint';

import { defaultIgnores, prettierOptions, prettierPluginSveltePath, prettierPluginTailwindcssPath, rules, rulesImport } from './config-eslint.mjs';

/**
 * @typedef {import('eslint').Linter.Config} EslintConfig
 * @typedef {import('eslint').Linter.RulesRecord} RulesRecord
 * @typedef {import('eslint').Linter.LanguageOptions} LanguageOptions
 * @typedef {import('eslint').Linter.Globals} Globals
 */

/** @type {string[]} */
const svelteIgnores = ['build', 'static', '.svelte-kit', 'pnpm-lock.yaml'];

const svelteSideEffectImportGroups = ['^\\u0000'];
const sveltePackageImportGroups = ['^node:(?!.*\\u0000$)', '^@?\\w(?!.*\\u0000$)'];
const svelteAliasImportGroups = ['^\\$(?!.*\\u0000$)'];
const svelteParentImportGroups = ['^\\.\\.(?!/?$)(?!.*\\u0000$)', '^\\.\\./?$(?!.*\\u0000$)'];
const svelteSiblingImportGroups = ['^\\./(?=.*/)(?!/?$)(?!.*\\u0000$)', '^\\.(?!/?$)(?!.*\\u0000$)', '^\\./?$(?!.*\\u0000$)'];
const svelteTypeImportGroups = ['\\u0000$'];

const svelteImportSortGroups = [
	svelteSideEffectImportGroups,
	sveltePackageImportGroups,
	svelteAliasImportGroups,
	svelteParentImportGroups,
	svelteSiblingImportGroups,
	svelteTypeImportGroups
];

/** @type {RulesRecord} */
const htmlRules = {
	...html.configs['flat/recommended'].rules,
	'self-closing-style': 0,
	'html/self-closing': 0,
	'@html-eslint/indent': ['error', 'tab']
};

/** @type {RulesRecord} */
const svelteOnlyRules = {
	'svelte/require-each-key': 0,
	'svelte/no-unused-props': 0,
	'svelte/no-at-html-tags': 0,
	'svelte/no-navigation-without-resolve': 0,
	'svelte/prefer-writable-derived': 0,
	'import-x/no-duplicates': 0,
	'@typescript-eslint/only-throw-error': 0
};

/**
 * @param {{ projectRoot: string, tsconfigPath: string, alias: Record<string, string[]> }} options
 */
const createResolverConfig = ({ projectRoot, tsconfigPath, alias }) => ({
	'import-x/resolver-next': [
		createTypeScriptImportResolver({
			alwaysTryTypes: true,
			project: tsconfigPath,
			extensions: ['.ts', '.js', '.mjs', '.d.ts', '.svelte'],
			alias
		})
	]
});

/**
 * @typedef {Object} SvelteEslintConfigOptions
 * @property {Object} svelteConfig - Svelte config from svelte.config.js
 * @property {string} [projectRoot] - Project root directory
 * @property {string} [tsconfigPath] - Path to tsconfig.json
 * @property {Record<string, string[]>} [alias] - Additional path aliases
 * @property {string[]} [extraIgnores] - Additional ignore patterns
 * @property {RulesRecord} [additionalRules] - Additional rules for TS/JS files
 * @property {RulesRecord} [additionalSvelteRules] - Additional rules for Svelte files
 */

/**
 * @param {SvelteEslintConfigOptions} options
 * @returns {EslintConfig[]}
 */
export const createSvelteEslintConfig = ({
	svelteConfig,
	projectRoot = process.cwd(),
	tsconfigPath = './tsconfig.json',
	alias = {},
	extraIgnores = [],
	additionalRules = {},
	additionalSvelteRules = {}
} = {}) => {
	if (!svelteConfig) {
		throw new Error('createSvelteEslintConfig requires the svelteConfig option');
	}

	/** @type {Globals} */
	const commonGlobals = {
		...globals.browser,
		...globals.node
	};

	/** @type {LanguageOptions} */
	const commonTSLanguageOptions = {
		globals: commonGlobals,
		ecmaVersion: 'latest',
		sourceType: 'module',
		parser: tsParser,
		parserOptions: {
			projectService: true,
			tsconfigRootDir: projectRoot,
			extraFileExtensions: ['.svelte']
		}
	};

	/** @type {LanguageOptions} */
	const commonSvelteLanguageOptions = {
		globals: commonGlobals,
		parser: svelteParser,
		parserOptions: {
			parser: tsParser,
			projectService: true,
			tsconfigRootDir: projectRoot,
			extraFileExtensions: ['.svelte'],
			svelteConfig
		}
	};

	const resolverConfig = createResolverConfig({ projectRoot, tsconfigPath, alias });
	const ignores = globalIgnores([...defaultIgnores, ...svelteIgnores, ...extraIgnores]);

	/** @type {RulesRecord} */
	const mergedRules = {
		...rules,
		...htmlRules,
		...rulesImport,
		'no-empty': 0,
		'@typescript-eslint/prefer-nullish-coalescing': 0,
		'import-x/no-duplicates': [0, { considerQueryString: true, 'prefer-inline': true }],
		'prettier/prettier': ['error', prettierOptions],
		...additionalRules
	};

	/** @type {RulesRecord} */
	const mergedSvelteRules = {
		...rules,
		...htmlRules,
		...svelteOnlyRules,
	'simple-import-sort/imports': [
		'error',
		{
			groups: svelteImportSortGroups
		}
	],
	'simple-import-sort/exports': 'error',
		'prettier/prettier': [
			'error',
			{
				...prettierOptions,
				parser: 'svelte',
				plugins: [prettierPluginTailwindcssPath, prettierPluginSveltePath],
				svelteStrictMode: true,
				svelteAllowShorthand: false,
				svelteIndentScriptAndStyle: false,
				svelteSortOrder: 'options-scripts-markup-styles'
			}
		],
		// Disable conflicting rules for Svelte files
		indent: 0,
		'@stylistic/indent': 0,
		'@stylistic/indent-legacy': 0,
		...additionalSvelteRules
	};

	return tseslint.config(
		defineConfig(
			tseslint.configs.recommendedTypeChecked,
			tseslint.configs.stylisticTypeChecked,
			eslintPluginImportX.flatConfigs.recommended,
			eslintPluginImportX.flatConfigs.typescript,
			...pluginQuery.configs['flat/recommended'],
			stylistic.configs.all,
			sortClassMembers.configs['flat/recommended'],
			html.configs['flat/recommended'],
			svelte.configs['flat/recommended'],
			svelte.configs['flat/prettier'],
			ignores,
			{
				files: ['**/*.{ts,js,mjs}'],
				languageOptions: commonTSLanguageOptions,
				settings: resolverConfig,
				plugins: {
					prettier: prettier,
					'simple-import-sort': simpleImportSort
				},
				rules: mergedRules
			},
			{
				files: ['**/*.svelte', '*.svelte'],
				languageOptions: commonSvelteLanguageOptions,
				settings: resolverConfig,
				plugins: {
					prettier: prettier,
					'simple-import-sort': simpleImportSort
				},
				rules: mergedSvelteRules
			},
			eslintConfigPrettier
		)
	);
};

export default createSvelteEslintConfig;
