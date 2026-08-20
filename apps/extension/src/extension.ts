import * as vscode from 'vscode';

import { ExtensionController } from './extension-controller';

// Keep a single controller instance between activate/deactivate hooks.
let active: ExtensionController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const app = new ExtensionController(context);

	// Registered before awaiting so deactivate can tear down a half-started controller.
	active = app;

	await app.activate();
}

export function deactivate(): void {
	active?.stopBackendServices();
	active = undefined;
}
