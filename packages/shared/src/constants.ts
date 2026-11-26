export const DEFAULT_KEY_FIX_ENABLED = false;

export const DEFAULT_AUTO_TUNNEL_ENABLED = false;

export const DASHBOARD_PLACEMENTS = ['editor', 'panel'] as const;

export type DashboardPlacement = (typeof DASHBOARD_PLACEMENTS)[number];

export const DEFAULT_DASHBOARD_PLACEMENT: DashboardPlacement = 'editor';

export const CLAUDE_CLI_STABLE_VERSION = '2.1.9';

export const CLAUDE_CLI_LATEST_VERSION = '2.1.322';

/** Claude Code 2.1.322 VS Code host: entrypoint `claude-vscode`, no agent-sdk segment. */
export const CLAUDE_CLI_USER_AGENT_SUFFIX = '(external, claude-vscode)';

export const MINIMAX_BASE_URLS = {
	global: 'https://api.minimax.io',
	china: 'https://api.minimaxi.com'
} as const;
