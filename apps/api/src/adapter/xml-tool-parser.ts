import type { ParsedToolCall } from '../types/proxy';

// Handles formats like:
// - <invoke name="read_file"><parameter name="target_file">...</parameter></invoke>
// - <search_files><path>...</path><regex>...</regex></search_files>
// - <read_file><path>...</path></read_file>
export class XmlToolParser {
	static parse(text: string): ParsedToolCall[] {
		const toolCalls: ParsedToolCall[] = [];

		const invokeMatches = text.matchAll(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi);

		for (const match of invokeMatches) {
			const name = match[1];
			const content = match[2];
			const args: Record<string, unknown> = {};

			const paramMatches = content.matchAll(/<parameter\s+name=["']([^"']+)["']>([^<]*)<\/parameter>/gi);

			for (const paramMatch of paramMatches) {
				const paramName = paramMatch[1];
				let paramValue: unknown = paramMatch[2];

				try {
					if ((paramValue as string).startsWith('[') || (paramValue as string).startsWith('{')) {
						paramValue = JSON.parse(paramValue as string);
					}
				} catch {
					// Keep as string
				}

				args[paramName] = paramValue;
			}

			toolCalls.push({ name, arguments: args });
		}

		const searchFilesMatches = text.matchAll(/<search_files>([\s\S]*?)<\/search_files>/gi);

		for (const match of searchFilesMatches) {
			const content = match[1];
			const args: Record<string, unknown> = {};

			const pathMatch = /<path>([^<]*)<\/path>/i.exec(content);
			const regexMatch = /<regex>([^<]*)<\/regex>/i.exec(content);
			const patternMatch = /<file_pattern>([^<]*)<\/file_pattern>/i.exec(content);

			if (pathMatch) args.path = pathMatch[1].trim();
			if (regexMatch) args.pattern = regexMatch[1].trim();
			if (patternMatch) args.glob = patternMatch[1].trim();

			toolCalls.push({ name: 'grep', arguments: args });
		}

		const readFileMatches = text.matchAll(/<read_file>([\s\S]*?)<\/read_file>/gi);

		for (const match of readFileMatches) {
			const content = match[1];
			const args: Record<string, unknown> = {};

			const pathMatch = /<path>([^<]*)<\/path>/i.exec(content);
			const startMatch = /<start_line>(\d+)<\/start_line>/i.exec(content);
			const endMatch = /<end_line>(\d+)<\/end_line>/i.exec(content);

			if (pathMatch) args.target_file = pathMatch[1].trim();
			if (startMatch) args.offset = parseInt(startMatch[1]);

			if (endMatch && startMatch) {
				args.limit = parseInt(endMatch[1]) - parseInt(startMatch[1]) + 1;
			}

			toolCalls.push({ name: 'read_file', arguments: args });
		}

		const grepMatches = text.matchAll(/<grep>([\s\S]*?)<\/grep>/gi);

		for (const match of grepMatches) {
			const content = match[1];
			const args: Record<string, unknown> = {};

			const patternMatch = /<pattern>([^<]*)<\/pattern>/i.exec(content);
			const pathMatch = /<path>([^<]*)<\/path>/i.exec(content);

			if (patternMatch) args.pattern = patternMatch[1].trim();
			if (pathMatch) args.path = pathMatch[1].trim();

			toolCalls.push({ name: 'grep', arguments: args });
		}

		return toolCalls;
	}

	static hasToolCalls(text: string): boolean {
		return /<invoke\s+name=/i.test(text) || /<search_files>/i.test(text) || /<read_file>/i.test(text) || /<grep>/i.test(text);
	}
}
