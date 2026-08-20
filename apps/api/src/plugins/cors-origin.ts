// Origins the dashboard can legitimately run under. VS Code and Cursor serve webview content
// from `vscode-webview://<uuid>`; the workbench shell itself is `vscode-file://vscode-app`.
// Loopback origins cover `pnpm dev` on apps/web. Anything else is a web page that must not be
// able to read settings or drive provider auth from a victim's browser, even over the tunnel.
const ALLOWED_SCHEMES = ['vscode-webview:', 'vscode-file:'];
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function isAllowedDashboardOrigin(origin: string | undefined): boolean {
	// Requests without an Origin header are not browser cross-origin requests: Cursor's backend
	// and any CLI client fall here. CORS has nothing to decide, so they pass through untouched.
	// A literal `null` origin is different — it comes from a sandboxed or file:// document, so
	// it is refused rather than trusted.
	if (origin === undefined || origin === '') return true;

	let parsed: URL;

	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}

	if (ALLOWED_SCHEMES.includes(parsed.protocol)) return true;

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

	return LOOPBACK_HOSTNAMES.includes(parsed.hostname);
}
