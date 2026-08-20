// Globals the extension injects into the dashboard webview HTML before any module runs.
// `__PORT__` is the port the local API listens on; `__ADMIN_KEY__` is the key required by
// administrative routes and is deliberately never persisted anywhere the webview can write.
interface Window {
	__PORT__?: number | null;
	__ADMIN_KEY__?: string | null;
	__TS__?: number;
}
