/**
 * Sanitized Claude Code 2.1.322 Opus 5.5 packet.
 *
 * Body fields are from a successful `api-request` (model `claude-opus-5-5`,
 * `output_config.effort: medium`) logged by Claude Code 2.1.317. No tokens
 * and no message text. Captured 2.1.317 and 2.1.322 requests differ only in
 * the version, so only `cliVersion` and `userAgent` moved to 2.1.322.
 *
 * The log does not record HTTP headers. The 2.1.322 binary builds
 * `User-Agent` as `claude-cli/<version> (external, <entrypoint>)`, and the
 * VS Code host sets the entrypoint to `claude-vscode` without
 * `CLAUDE_AGENT_SDK_VERSION`, so there is no `agent-sdk` segment.
 * `agent-sdk/0.2.7` is not in this binary.
 */
export const CLAUDE_CODE_OPUS_PACKET = {
	cliVersion: '2.1.322',
	userAgent: 'claude-cli/2.1.322 (external, claude-vscode)',
	identity: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
	betas: [
		'claude-code-20250219',
		'oauth-2025-04-20',
		'interleaved-thinking-2025-05-14',
		'context-management-2025-06-27',
		'prompt-caching-scope-2026-01-05',
		'per-turn-control-2026-07-01',
		'mid-conversation-tool-changes-2026-07-01',
		'advisor-tool-2026-03-01',
		'thinking-token-count-2026-05-13',
		'advanced-tool-use-2025-11-20',
		'mid-conversation-system-clear-at-2026-08-21',
		'effort-2025-11-24',
		'dangerous-tool-use-2026-09-03',
		'thinking-binding-controls-2026-08-01',
		'thinking-display-updates-2026-08-18',
		'afk-mode-2026-01-31',
		'extended-cache-ttl-2025-04-11',
		'cache-diagnosis-2026-04-07'
	],
	thinking: { type: 'adaptive', display: 'updates' },
	contextManagement: {
		edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]
	}
} as const;
