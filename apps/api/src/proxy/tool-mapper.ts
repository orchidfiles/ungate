import { logger } from 'src/utils/logger';

import type { Tool } from '../types';
import type { ToolMapResult } from '../types/proxy';

const TOOL_NAME_MAPPING: Record<string, string> = {
	// Cursor-specific tools (PascalCase)
	Shell: 'Bash',
	LS: 'Glob',
	Delete: 'Edit',
	StrReplace: 'Edit',
	EditNotebook: 'NotebookEdit',
	ReadLints: 'Read',
	SemanticSearch: 'Grep',

	// File operations (snake_case)
	read_file: 'Read',
	view_file: 'Read',
	write: 'Write',
	write_to_file: 'Write',
	write_file: 'Write',
	str_replace_editor: 'Edit',
	replace_in_file: 'Edit',
	list_files: 'Glob',
	list_dir: 'Glob',
	find_files: 'Glob',

	// Search operations
	codebase_search: 'Grep',
	file_search: 'Grep',
	grep_search: 'Grep',
	search_files: 'Grep',

	// Execution
	execute_bash: 'Bash',
	execute_command: 'Bash',
	run_terminal_cmd: 'Bash',
	run_command: 'Bash',
	bash: 'Bash',
	terminal: 'Bash',

	// Web operations
	web_search: 'WebSearch',
	search_web: 'WebSearch',
	search: 'WebSearch',
	fetch_web: 'WebFetch',
	web_fetch: 'WebFetch',
	fetch_url: 'WebFetch',
	http_request: 'WebFetch',

	// Task management
	create_task: 'Task',
	spawn_agent: 'Task',
	delegate_task: 'Task',
	todo: 'TodoWrite',
	task_list: 'TodoWrite',

	// Notebook operations
	edit_notebook: 'NotebookEdit',
	notebook_edit: 'NotebookEdit',

	// Interactive operations
	ask_user: 'AskUserQuestion',
	prompt_user: 'AskUserQuestion',

	// Browser/UI operations
	browser_action: 'WebFetch'
};

const VALID_CLAUDE_CODE_TOOLS = new Set([
	'Task',
	'TaskOutput',
	'Bash',
	'Glob',
	'Grep',
	'ExitPlanMode',
	'Read',
	'Edit',
	'Write',
	'NotebookEdit',
	'WebFetch',
	'TodoWrite',
	'WebSearch',
	'KillShell',
	'AskUserQuestion',
	'Skill',
	'EnterPlanMode',
	// Cursor-specific tools (pass through as-is)
	'CreatePlan',
	'AskQuestion',
	'SwitchMode'
]);

export class ToolMapper {
	static map(tools: Tool[]): ToolMapResult {
		const usedNames = new Set<string>();
		const filteredTools: Tool[] = [];
		const reverseMapping: Record<string, string> = {};

		for (const tool of tools) {
			const originalName = tool.name;

			if (VALID_CLAUDE_CODE_TOOLS.has(tool.name)) {
				let uniqueName = tool.name;
				let suffix = 1;

				while (usedNames.has(uniqueName)) {
					uniqueName = `${tool.name}_${suffix}`;
					suffix++;
				}
				usedNames.add(uniqueName);

				if (uniqueName !== originalName) {
					reverseMapping[uniqueName] = originalName;
				}

				filteredTools.push({ ...tool, name: uniqueName });
				continue;
			}

			const mappedName = TOOL_NAME_MAPPING[tool.name];

			if (mappedName) {
				let uniqueName = mappedName;
				let suffix = 1;

				while (usedNames.has(uniqueName)) {
					uniqueName = `${mappedName}_${suffix}`;
					suffix++;
				}
				usedNames.add(uniqueName);
				reverseMapping[uniqueName] = originalName;

				logger.log(`Mapped tool: ${tool.name} -> ${uniqueName}`);
				filteredTools.push({ ...tool, name: uniqueName });
			}
			// Unknown tools are silently dropped for OAuth compatibility
		}

		return { tools: filteredTools, reverseMapping };
	}
}
