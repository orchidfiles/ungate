import * as vscode from 'vscode';

import { inspectCursorCapabilities } from './cursor-capability-diagnostic';
import { ExtensionController } from './extension-controller';

// Keep a single controller instance between activate/deactivate hooks.
let active: ExtensionController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('ungate.diagnoseCursorCapabilities', async () => {
			const cursor = (vscode as unknown as { cursor?: unknown }).cursor;
			const report = inspectCursorCapabilities(cursor);
			const document = await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify(
					{
						...report,
						note: 'Local capability check only. No network requests or settings changes. Subscription billing and tool compatibility remain unverified.'
					},
					null,
					2
				)
			});
			await vscode.window.showTextDocument(document);
		})
	);
	const app = new ExtensionController(context);

	app.activate();
	active = app;
}

export function deactivate(): void {
	active?.stopBackendServices();
	active = undefined;
}
