import { describe, expect, it } from 'vitest';

import { ToolMapper } from 'src/proxy/tool-mapper';

describe('proxy-tool-mapper', () => {
	it('maps known aliases and creates reverse mapping', () => {
		const result = ToolMapper.map([
			{ name: 'read_file', description: '', input_schema: {} },
			{ name: 'SemanticSearch', description: '', input_schema: {} }
		]);

		expect(result.tools.map((tool) => tool.name)).toEqual(['Read', 'Grep']);
		expect(result.reverseMapping.Read).toBe('read_file');
		expect(result.reverseMapping.Grep).toBe('SemanticSearch');
	});

	it('keeps valid tools and deduplicates by suffix', () => {
		const result = ToolMapper.map([
			{ name: 'Read', description: '', input_schema: {} },
			{ name: 'read_file', description: '', input_schema: {} }
		]);

		expect(result.tools.map((tool) => tool.name)).toEqual(['Read', 'Read_1']);
		expect(result.reverseMapping.Read_1).toBe('read_file');
	});

	it('drops unknown tools', () => {
		const result = ToolMapper.map([{ name: 'UnknownTool', description: '', input_schema: {} }]);
		expect(result.tools).toHaveLength(0);
		expect(result.reverseMapping).toEqual({});
	});

	it('deduplicates repeated mapped aliases with increasing suffixes', () => {
		const result = ToolMapper.map([
			{ name: 'read_file', description: '', input_schema: {} },
			{ name: 'view_file', description: '', input_schema: {} },
			{ name: 'Read', description: '', input_schema: {} }
		]);

		expect(result.tools.map((tool) => tool.name)).toEqual(['Read', 'Read_1', 'Read_2']);
		expect(result.reverseMapping.Read).toBe('read_file');
		expect(result.reverseMapping.Read_1).toBe('view_file');
		expect(result.reverseMapping.Read_2).toBe('Read');
	});
});
