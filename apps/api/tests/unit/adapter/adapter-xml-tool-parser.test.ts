import { describe, expect, it } from 'vitest';

import { XmlToolParser } from 'src/adapter/xml-tool-parser';

describe('xml-tool-parser', () => {
	it('detects tool calls in different xml shapes', () => {
		expect(XmlToolParser.hasToolCalls('<invoke name="read_file"></invoke>')).toBe(true);
		expect(XmlToolParser.hasToolCalls('<search_files><path>src</path></search_files>')).toBe(true);
		expect(XmlToolParser.hasToolCalls('plain text')).toBe(false);
	});

	it('parses invoke/search/read/grep formats', () => {
		const parsed = XmlToolParser.parse(`
<invoke name="read_file">
  <parameter name="path">/tmp/a.ts</parameter>
  <parameter name="offset">10</parameter>
</invoke>
<search_files>
  <path>src</path>
  <regex>foo</regex>
  <file_pattern>*.ts</file_pattern>
</search_files>
<read_file>
  <path>src/main.ts</path>
  <start_line>10</start_line>
  <end_line>19</end_line>
</read_file>
<grep>
  <pattern>describe\\(</pattern>
  <path>tests</path>
</grep>
`);

		expect(parsed).toHaveLength(4);
		expect(parsed[0]).toEqual({
			name: 'read_file',
			arguments: { path: '/tmp/a.ts', offset: '10' }
		});
		expect(parsed[1]).toEqual({
			name: 'grep',
			arguments: { path: 'src', pattern: 'foo', glob: '*.ts' }
		});
		expect(parsed[2]).toEqual({
			name: 'read_file',
			arguments: { target_file: 'src/main.ts', offset: 10, limit: 10 }
		});
		expect(parsed[3]).toEqual({
			name: 'grep',
			arguments: { pattern: 'describe\\(', path: 'tests' }
		});
	});

	it('keeps malformed invoke parameter values as strings', () => {
		const parsed = XmlToolParser.parse(`
<invoke name="tool">
  <parameter name="payload">{"broken"</parameter>
</invoke>
`);

		expect(parsed).toEqual([
			{
				name: 'tool',
				arguments: { payload: '{"broken"' }
			}
		]);
	});
});
