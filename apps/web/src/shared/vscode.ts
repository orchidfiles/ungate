import type { WebviewToExtension } from '@ungate/shared/frontend';

// acquireVsCodeApi() may only be called once — singleton
const vscodeApi = (
	window as Window & {
		acquireVsCodeApi?: () => { postMessage: (message: unknown) => void };
	}
).acquireVsCodeApi?.();

export function postExtensionMessage(message: WebviewToExtension): void {
	vscodeApi?.postMessage(message);
}
