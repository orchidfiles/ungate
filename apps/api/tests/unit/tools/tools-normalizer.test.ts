import { describe, expect, it } from 'vitest';

import { ToolNormalizer } from 'src/tools/normalizer';

describe('tools-normalizer', () => {
	it('normalizes Read parameters and strips invalid fields', () => {
		const normalized = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '1',
			name: 'Read',
			input: {
				target_file: 'a.ts',
				command: 'rm -rf /',
				working_directory: '/tmp',
				description: 'x'
			}
		});

		expect(normalized.input.path).toBe('a.ts');
		expect(normalized.input.target_file).toBeUndefined();
		expect(normalized.input.command).toBeUndefined();
		expect(normalized.input.working_directory).toBeUndefined();
		expect(normalized.input.description).toBeUndefined();
	});

	it('normalizes Grep/Edit/Glob/Shell fields', () => {
		const grep = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '2',
			name: 'Grep',
			input: { '-C': '5', '-A': 'bad', head_limit: '20' }
		});
		expect(grep.input['-C']).toBe(5);
		expect(grep.input['-A']).toBeUndefined();
		expect(grep.input.head_limit).toBe(20);

		const edit = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '3',
			name: 'Edit',
			input: { lineNumber: '-2' }
		});
		expect(edit.input.lineNumber).toBeUndefined();

		const glob = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '4',
			name: 'Glob',
			input: { glob: '*.ts' }
		});
		expect(glob.input.pattern).toBe('*.ts');

		const shell = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '5',
			name: 'Shell',
			input: { command: 10, required_permissions: '["all"]' }
		});
		expect(shell.input.command).toBe('10');
		expect(shell.input.required_permissions).toEqual(['all']);
	});

	it('handles malformed Shell permissions and non-array values', () => {
		const malformed = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '6',
			name: 'Shell',
			input: { required_permissions: '[all]' }
		});
		expect(malformed.input.required_permissions).toEqual(['[all]']);

		const scalar = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '7',
			name: 'Shell',
			input: { required_permissions: 123 }
		});
		expect(scalar.input.required_permissions).toBeUndefined();
	});

	it('normalizes Bash aliases and file aliases for Read', () => {
		const bash = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '8',
			name: 'Bash',
			input: { command: true }
		});
		expect(bash.input.command).toBe('true');

		const readFromFile = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '9',
			name: 'Read',
			input: { file: 'a.ts' }
		});
		expect(readFromFile.input.path).toBe('a.ts');
		expect(readFromFile.input.file).toBeUndefined();

		const readFromFilename = ToolNormalizer.normalize({
			type: 'tool_use',
			id: '10',
			name: 'Read',
			input: { filename: 'b.ts' }
		});
		expect(readFromFilename.input.path).toBe('b.ts');
		expect(readFromFilename.input.filename).toBeUndefined();
	});

	it('detects whether input changed', () => {
		const original = { type: 'tool_use' as const, id: '1', name: 'Shell', input: { command: 1 } };
		const normalized = ToolNormalizer.normalize(original);
		expect(ToolNormalizer.hasChanged(original, normalized)).toBe(true);
	});
});
