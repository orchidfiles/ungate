import { describe, expect, it } from 'vitest';

import { ToolTranslator } from 'src/tools/translator';

describe('tools-translator', () => {
	it('translates legacy tool xml blocks', () => {
		const input = `
<function_calls>
<search_files>
<path>src</path>
<regex>describe\\(</regex>
<file_pattern>*.test.ts</file_pattern>
</search_files>
<read_file>
<path>src/main.ts</path>
<start_line>5</start_line>
<end_line>9</end_line>
</read_file>
</function_calls>
`;

		const out = ToolTranslator.translate(input);
		expect(out).toContain('<invoke name="codebase_search">');
		expect(out).toContain('<invoke name="read_file">');
		expect(out).toContain('<parameter name="offset">5</parameter>');
		expect(out).toContain('<parameter name="limit">5</parameter>');
	});

	it('normalizes parameter aliases and is idempotent', () => {
		const input = `<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>`;
		const once = ToolTranslator.translate(input);
		const twice = ToolTranslator.translate(once);

		expect(once).toContain('<parameter name="target_file">a.ts</parameter>');
		expect(twice).toBe(once);
	});

	it('detects whether translation is needed', () => {
		expect(ToolTranslator.needsTranslation('plain text')).toBe(false);
		expect(ToolTranslator.needsTranslation('<grep><pattern>x</pattern></grep>')).toBe(true);
		expect(ToolTranslator.needsTranslation('<parameter name="file">x</parameter>')).toBe(true);
	});
});
