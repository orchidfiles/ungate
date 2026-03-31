import { Api } from '$shared/api';

import type { AppSettings, WebviewToExtension } from '@ungate/shared/frontend';

interface SettingsStore {
	readonly settings: AppSettings | null;
	readonly loading: boolean;
	readonly saving: boolean;
	readonly saved: boolean;
	readonly restarting: boolean;
	readonly error: string | null;
	load(): Promise<void>;
	save(update: Partial<AppSettings>): Promise<void>;
	saveAndRestart(update: Partial<AppSettings>): Promise<void>;
}

let settings = $state<AppSettings | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let saving = $state(false);
let saved = $state(false);
let restarting = $state(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function postExtensionMessage(message: WebviewToExtension): void {
	const acquireVsCodeApi = (
		window as Window & {
			acquireVsCodeApi?: () => { postMessage: (message: unknown) => void };
		}
	).acquireVsCodeApi;

	acquireVsCodeApi?.().postMessage(message);
}

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

	try {
		await Api.updateSettings(update);
		settings = { ...settings!, ...update };
		saved = true;

		if (savedTimer) clearTimeout(savedTimer);
		savedTimer = setTimeout(() => {
			saved = false;
		}, 2000);
	} catch (e) {
		error = extractError(e);
	}

	saving = false;
}

async function saveAndRestart(update: Partial<AppSettings>): Promise<void> {
	await save(update);

	if (error) {
		return;
	}

	restarting = true;
	postExtensionMessage({ type: 'restart-server' });
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
		load,
		save,
		saveAndRestart
	};

	return store;
}
