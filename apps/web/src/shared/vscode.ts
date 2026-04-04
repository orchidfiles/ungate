// acquireVsCodeApi() may only be called once — singleton
const vscodeApi = (
	window as Window & {
		acquireVsCodeApi?: () => { postMessage: (message: unknown) => void };
	}
).acquireVsCodeApi?.();

export function postExtensionMessage(message: { type: string; [key: string]: unknown }): void {
	vscodeApi?.postMessage(message);
}
