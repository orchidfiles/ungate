import { Api } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

import type { AppSettings } from '@ungate/shared/frontend';

interface SettingsStore {
	readonly settings: AppSettings | null;
	readonly loading: boolean;
	readonly saving: boolean;
	readonly saved: boolean;
	readonly restarting: boolean;
	readonly error: string | null;
	readonly statusMessage: string | null;
	load(): Promise<void>;
	save(update: Partial<AppSettings>): Promise<void>;
	saveAndRestart(update: Partial<AppSettings>): Promise<void>;
	resetStatus(): void;
	completeRestart(): void;
}

let settings = $state<AppSettings | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let saving = $state(false);
let saved = $state(false);
let restarting = $state(false);
let statusMessage = $state<string | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function extractError(e: unknown): string {
	if (e instanceof Error) {
		return e.message;
	}

	return String(e);
}

async function load(): Promise<void> {
	loading = true;
	error = null;

	try {
		settings = await Api.fetchSettings();
	} catch (e) {
		error = extractError(e);
	}

	loading = false;
}

async function save(update: Partial<AppSettings>): Promise<void> {
	saving = true;
	error = null;
	statusMessage = null;
	saved = false;

	try {
		await Api.updateSettings(update);
		settings = { ...settings!, ...update };
		saved = true;

		if (savedTimer) clearTimeout(savedTimer);
		savedTimer = setTimeout(() => {
			saved = false;
			if (!restarting) {
				statusMessage = null;
			}
		}, 2000);
	} catch (e) {
		error = extractError(e);
		statusMessage = 'Failed to save settings';
	}

	saving = false;
}

async function saveAndRestart(update: Partial<AppSettings>): Promise<void> {
	await save(update);

	if (error) {
		return;
	}

	restarting = true;
	statusMessage = 'Restarting server...';
	postExtensionMessage({ type: 'restart-server' });

	if (restartTimer) {
		clearTimeout(restartTimer);
	}

	restartTimer = setTimeout(() => {
		completeRestart();
	}, 2500);
}

function resetStatus(): void {
	statusMessage = null;
	error = null;
}

function completeRestart(): void {
	restarting = false;
	statusMessage = 'Server restarted';
}

export function getSettingsStore(): SettingsStore {
	const store: SettingsStore = {
		get settings() {
			return settings;
		},
		get loading() {
			return loading;
		},
		get saving() {
			return saving;
		},
		get saved() {
			return saved;
		},
		get restarting() {
			return restarting;
		},
		get error() {
			return error;
		},
		get statusMessage() {
			return statusMessage;
		},
		load,
		save,
		saveAndRestart,
		resetStatus,
		completeRestart
	};

	return store;
}
