const PARAMETER_NAME_MAP: Record<string, string> = {
	path: 'target_file',
	file: 'target_file',
	filepath: 'target_file',
	filename: 'target_file',
	query: 'query',
	pattern: 'pattern',
	search_query: 'query'
};

export class ToolTranslator {
	static translate(text: string): string {
		let translated = text;

		translated = translated.replace(/<function_calls>\s*/gi, '');
		translated = translated.replace(/\s*<\/function_calls>/gi, '');
		translated = translated.replace(/<function_calls\s*\/>/gi, '');

		translated = translated.replace(
			/<search_files>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<regex>([^<]+)<\/regex>\s*\n?\s*<file_pattern>([^<]+)<\/file_pattern>\s*\n?\s*<\/search_files>/gis,
			(_match: string, path: string, regex: string, filePattern: string) => {
				const query = `files matching pattern ${filePattern.trim()} in ${path.trim()} with regex ${regex.trim()}`;

				return `<invoke name="codebase_search">
<parameter name="query">${query}</parameter>
<parameter name="target_directories">[]</parameter>
</invoke>`;
			}
		);

		translated = translated.replace(
			/<search_files>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<regex>([^<]+)<\/regex>\s*\n?\s*<\/search_files>/gis,
			(_match: string, path: string, regex: string) => {
				const query = `files in ${path.trim()} matching regex ${regex.trim()}`;

				return `<invoke name="codebase_search">
<parameter name="query">${query}</parameter>
<parameter name="target_directories">[]</parameter>
</invoke>`;
			}
		);

		translated = translated.replace(
			/<read_file>\s*\n?\s*<path>([^<]+)<\/path>(?:\s*\n?\s*<start_line>(\d+)<\/start_line>)?(?:\s*\n?\s*<end_line>(\d+)<\/end_line>)?\s*\n?\s*<\/read_file>/gis,
			(_match: string, path: string, startLine: string, endLine: string) => {
				let result = `<invoke name="read_file">
<parameter name="target_file">${path.trim()}</parameter>`;

				if (startLine) {
					result += `\n<parameter name="offset">${startLine}</parameter>`;

					if (endLine) {
						const limit = parseInt(endLine) - parseInt(startLine) + 1;
						result += `\n<parameter name="limit">${limit}</parameter>`;
					}
				}

				result += `\n</invoke>`;

				return result;
			}
		);

		translated = translated.replace(
			/<read_file>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<\/read_file>/gis,
			(_match: string, path: string) => {
				return `<invoke name="read_file">
<parameter name="target_file">${path.trim()}</parameter>
</invoke>`;
			}
		);

		translated = translated.replace(
			/<grep>\s*\n?\s*<pattern>([^<]+)<\/pattern>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<\/grep>/gis,
			(_match: string, pattern: string, path: string) => {
				return `<invoke name="grep">
<parameter name="pattern">${pattern.trim()}</parameter>
<parameter name="path">${path.trim()}</parameter>
</invoke>`;
			}
		);

		for (const [incorrect, correct] of Object.entries(PARAMETER_NAME_MAP)) {
			translated = translated.replace(
				new RegExp(`<parameter\\s+name=["']${incorrect}["']>`, 'gi'),
				`<parameter name="${correct}">`
			);
			translated = translated.replace(
				new RegExp(`<parameter\\s+name=['"]${incorrect}['"]>`, 'gi'),
				`<parameter name="${correct}">`
			);
		}

		translated = translated.replace(/\n\s*\n\s*\n+/g, '\n\n');
		const lines = translated.split('\n');
		translated = lines
			.map((line) => line.trimEnd())
			.join('\n')
			.trim();

		return translated;
	}

	static needsTranslation(text: string): boolean {
		return (
			/<function_calls/i.test(text) ||
			/<\/function_calls>/i.test(text) ||
			/<parameter\s+name=["'](path|file|filepath|filename)["']>/i.test(text) ||
			/<search_files/i.test(text) ||
			/<read_file/i.test(text) ||
			/<\/search_files>/i.test(text) ||
			/<\/read_file>/i.test(text) ||
			/<grep>/i.test(text) ||
			/<\/grep>/i.test(text)
		);
	}
}
