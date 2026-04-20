import * as vscode from 'vscode';

import { ExtensionController } from './extension-controller';

// Keep a single controller instance between activate/deactivate hooks.
let active: ExtensionController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const app = new ExtensionController(context);

	app.activate();
	active = app;
}

export function deactivate(): void {
	active?.stopBackendServices();
	active = undefined;
}
