import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

const config = {
	logPrefix: '[openai-key-fix]',
	key: {
		storage: 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
		toggleCommand: 'aiSettings.usingOpenAIKey.toggle',
		settingsKey: 'keyFixEnabled'
	},
	files: {
		stateDb: 'state.vscdb',
		stateDbGlob: 'state.vscdb*'
	},
	timers: {
		initialCheckMs: 3000,
		debounceMs: 1000,
		pollMs: 5000
	},
	sql: {
		readOpenAiKey(storageKey: string): string {
			return `SELECT value FROM ItemTable WHERE key = '${storageKey}';`;
		}
	}
} as const;

type Logger = (message: string) => void;

type StateChangeHandler = (enabled: boolean) => void;

interface OpenAiKeyState {
	useOpenAIKey?: boolean;
}

interface ServiceState {
	enabled: boolean;
	running: boolean;
	activated: boolean;
}

interface RuntimeState {
	pollInterval: NodeJS.Timeout | null;
	debounceTimer: NodeJS.Timeout | null;
	initialTimeout: NodeJS.Timeout | null;
	watcher: vscode.FileSystemWatcher | null;
	watcherSubscriptions: vscode.Disposable[];
}

export class OpenAiKeyFix {
	private readonly stateDbPath: string;
	private sqlite3Path: string | null = null;
	private state: ServiceState = {
		enabled: true,
		running: false,
		activated: false
	};

	private runtime: RuntimeState = {
		pollInterval: null,
		debounceTimer: null,
		initialTimeout: null,
		watcher: null,
		watcherSubscriptions: []
	};

	private lastUnavailableReason: string | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onStateChange: StateChangeHandler,
		private readonly log: Logger
	) {
		const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
		this.stateDbPath = path.join(globalStorageDir, config.files.stateDb);
	}

	public isEnabled(): boolean {
		return this.state.enabled;
	}

	public async activate(): Promise<void> {
		this.state.activated = true;
		const restoredState = this.context.globalState.get<boolean>(config.key.settingsKey, true);
		this.sqlite3Path = await this.findSqlite3();

		if (!restoredState) {
			await this.syncState(false);

			return;
		}

		const unavailableReason = this.getUnavailableReason();

		if (unavailableReason) {
			await this.syncState(false);
			this.log(`${config.logPrefix} ${unavailableReason}`);

			return;
		}

		await this.syncState(true);
		this.startMonitoring();
	}

	public async setEnabledByUser(nextEnabled: boolean): Promise<void> {
		if (nextEnabled) {
			await this.enableByUser();

			return;
		}

		await this.disableByUser();
	}

	public stop(): void {
		this.state.activated = false;
		this.stopMonitoring();
	}

	private getUnavailableReason(): string | null {
		if (!fs.existsSync(this.stateDbPath)) {
			return `${config.files.stateDb} not found`;
		}

		if (!this.sqlite3Path) {
			return 'sqlite3 is not installed';
		}

		return null;
	}

	private startMonitoring(): void {
		if (!this.state.enabled || !this.state.activated) {
			return;
		}

		this.stopMonitoring();
		const globalStorageDir = path.dirname(this.stateDbPath);
		this.runtime.initialTimeout = setTimeout(() => {
			void this.checkAndFix();
		}, config.timers.initialCheckMs);

		this.runtime.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(globalStorageDir), config.files.stateDbGlob)
		);
		const handleFsEvent = (): void => {
			if (this.runtime.debounceTimer) {
				clearTimeout(this.runtime.debounceTimer);
			}

			this.runtime.debounceTimer = setTimeout(() => {
				void this.checkAndFix();
			}, config.timers.debounceMs);
		};

		this.runtime.watcherSubscriptions = [
			this.runtime.watcher.onDidChange(handleFsEvent),
			this.runtime.watcher.onDidCreate(handleFsEvent)
		];

		this.runtime.pollInterval = setInterval(() => {
			void this.checkAndFix();
		}, config.timers.pollMs);
	}

	private stopMonitoring(): void {
		if (this.runtime.initialTimeout) {
			clearTimeout(this.runtime.initialTimeout);
			this.runtime.initialTimeout = null;
		}

		if (this.runtime.pollInterval) {
			clearInterval(this.runtime.pollInterval);
			this.runtime.pollInterval = null;
		}

		if (this.runtime.debounceTimer) {
			clearTimeout(this.runtime.debounceTimer);
			this.runtime.debounceTimer = null;
		}

		for (const watcherSubscription of this.runtime.watcherSubscriptions) {
			watcherSubscription.dispose();
		}

		this.runtime.watcherSubscriptions = [];

		if (this.runtime.watcher) {
			this.runtime.watcher.dispose();
			this.runtime.watcher = null;
		}
	}

	private async checkAndFix(): Promise<void> {
		if (!this.state.enabled || !this.state.activated || this.state.running) {
			return;
		}

		const unavailableReason = this.getUnavailableReason();

		if (unavailableReason) {
			if (this.lastUnavailableReason !== unavailableReason) {
				this.lastUnavailableReason = unavailableReason;
				this.log(`${config.logPrefix} monitoring unavailable: ${unavailableReason}`);
			}

			return;
		}

		this.lastUnavailableReason = null;
		this.state.running = true;

		try {
			const enabled = await this.readUseOpenAiKey();

			if (enabled === false) {
				this.log(`${config.logPrefix} key was disabled, re-enabling`);
				await vscode.commands.executeCommand(config.key.toggleCommand);
			}
		} catch (error) {
			this.log(`${config.logPrefix} check failed: ${String(error)}`);
		} finally {
			this.state.running = false;
		}
	}

	private async disableOpenAiKeyIfNeeded(): Promise<void> {
		try {
			const current = await this.readUseOpenAiKey();

			if (current === true) {
				await vscode.commands.executeCommand(config.key.toggleCommand);
			}
		} catch (error) {
			this.log(`${config.logPrefix} failed to disable key: ${String(error)}`);
		}
	}

	private async readUseOpenAiKey(): Promise<boolean | undefined> {
		if (!this.sqlite3Path) {
			return undefined;
		}

		const query = config.sql.readOpenAiKey(config.key.storage);
		const { stdout } = await execFileAsync(this.sqlite3Path, [this.stateDbPath, query]);
		const raw = stdout.trim();

		if (!raw) {
			return undefined;
		}

		const parsed = JSON.parse(raw) as OpenAiKeyState;

		return parsed.useOpenAIKey;
	}

	private async syncState(enabled: boolean): Promise<void> {
		this.state.enabled = enabled;
		await this.context.globalState.update(config.key.settingsKey, enabled);
		this.onStateChange(enabled);
	}

	private async enableByUser(): Promise<void> {
		const unavailableReason = this.getUnavailableReason();

		if (unavailableReason) {
			throw new Error(unavailableReason);
		}

		await this.syncState(true);
		this.startMonitoring();
		await this.checkAndFix();
	}

	private async disableByUser(): Promise<void> {
		await this.syncState(false);
		this.stopMonitoring();
		await this.disableOpenAiKeyIfNeeded();
	}

	private async findSqlite3(): Promise<string | null> {
		const command = process.platform === 'win32' ? 'where' : 'which';

		try {
			const { stdout } = await execFileAsync(command, ['sqlite3']);
			const pathFromStdout = stdout.trim().split(/\r?\n/)[0];

			if (!pathFromStdout) {
				return null;
			}

			return pathFromStdout;
		} catch {
			return null;
		}
	}
}
