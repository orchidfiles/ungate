import { logger } from 'src/utils/logger';

import type { ToolUseBlock } from '../types/proxy';

export class ToolNormalizer {
	static normalize(toolUse: ToolUseBlock): ToolUseBlock {
		const normalized = { ...toolUse, input: { ...toolUse.input } };
		const originalInput = JSON.stringify(toolUse.input);

		if (normalized.name === 'Read' || normalized.name.startsWith('Read_')) {
			const invalidParams = ['command', 'working_directory', 'description'];

			for (const param of invalidParams) {
				if (param in normalized.input) {
					delete normalized.input[param];
				}
			}

			if (normalized.input.target_file && !normalized.input.path) {
				normalized.input.path = normalized.input.target_file;
				delete normalized.input.target_file;
			}

			if (normalized.input.file && !normalized.input.path) {
				normalized.input.path = normalized.input.file;
				delete normalized.input.file;
			}

			if (normalized.input.filename && !normalized.input.path) {
				normalized.input.path = normalized.input.filename;
				delete normalized.input.filename;
			}
		}

		if (normalized.name === 'Grep' || normalized.name.startsWith('Grep_')) {
			for (const key of ['-C', '-A', '-B']) {
				if (key in normalized.input) {
					const value = normalized.input[key];

					if (typeof value === 'string') {
						const parsed = parseInt(value, 10);

						if (!isNaN(parsed)) {
							normalized.input[key] = parsed;
						} else {
							delete normalized.input[key];
						}
					}
				}
			}

			if ('head_limit' in normalized.input && typeof normalized.input.head_limit === 'string') {
				const parsed = parseInt(normalized.input.head_limit, 10);

				if (!isNaN(parsed)) {
					normalized.input.head_limit = parsed;
				} else {
					delete normalized.input.head_limit;
				}
			}
		}

		if (normalized.name === 'Edit' || normalized.name.startsWith('Edit_')) {
			if ('lineNumber' in normalized.input) {
				const lineNumber = normalized.input.lineNumber;

				if (typeof lineNumber === 'string') {
					const parsed = parseInt(lineNumber, 10);

					if (!isNaN(parsed) && parsed >= 0) {
						normalized.input.lineNumber = parsed;
					} else {
						delete normalized.input.lineNumber;
					}
				}

				if (typeof lineNumber === 'number' && lineNumber < 0) {
					delete normalized.input.lineNumber;
				}
			}
		}

		if (normalized.name === 'Glob' || normalized.name.startsWith('Glob_')) {
			if (!normalized.input.pattern && !normalized.input.glob_pattern) {
				if (normalized.input.glob) {
					normalized.input.pattern = normalized.input.glob;
					delete normalized.input.glob;
				}
			}
		}

		if (normalized.name === 'Bash' || normalized.name.startsWith('Bash_')) {
			if (normalized.input.command && typeof normalized.input.command !== 'string') {
				normalized.input.command = String(normalized.input.command);
			}
		}

		if (normalized.name === 'Shell' || normalized.name.startsWith('Shell_')) {
			if (normalized.input.command && typeof normalized.input.command !== 'string') {
				normalized.input.command = String(normalized.input.command);
			}

			if ('required_permissions' in normalized.input) {
				const perms = normalized.input.required_permissions;

				if (typeof perms === 'string') {
					if (perms.startsWith('[') && perms.endsWith(']')) {
						try {
							const parsed = JSON.parse(perms);

							if (Array.isArray(parsed)) {
								normalized.input.required_permissions = parsed;
							} else {
								normalized.input.required_permissions = [perms];
							}
						} catch {
							normalized.input.required_permissions = [perms];
						}
					} else {
						normalized.input.required_permissions = [perms];
					}
				} else if (!Array.isArray(perms)) {
					delete normalized.input.required_permissions;
				}
			}
		}

		const finalInput = JSON.stringify(normalized.input);

		if (originalInput !== finalInput) {
			logger.log(`[Normalizer] CHANGED: ${toolUse.name} - ${originalInput} -> ${finalInput}`);
		}

		return normalized;
	}

	static hasChanged(original: ToolUseBlock, normalized: ToolUseBlock): boolean {
		return JSON.stringify(original.input) !== JSON.stringify(normalized.input);
	}
}
