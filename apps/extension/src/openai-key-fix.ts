import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_KEY_FIX_ENABLED, sleep } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { RuntimeStateStore } from './runtime-state';
import { config as runtimeStateConfig } from './runtime-state/config';
import { CursorStateDbReader } from './utils/cursor-state-db-reader';

const config = {
	logPrefix: '[openai-key-fix]',
	key: {
		storage: 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
		toggleCommand: 'aiSettings.usingOpenAIKey.toggle'
	},
	files: {
		stateDb: 'state.vscdb',
		stateDbGlob: 'state.vscdb*'
	},
	timers: {
		initialCheckMs: runtimeStateConfig.openAiKeyFix.initialCheckMs,
		debounceMs: runtimeStateConfig.openAiKeyFix.debounceMs,
		pollMs: runtimeStateConfig.openAiKeyFix.pollMs
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
	debounceAbort: AbortController | null;
	initialAbort: AbortController | null;
	watcher: vscode.FileSystemWatcher | null;
	watcherSubscriptions: vscode.Disposable[];
}

export class OpenAiKeyFix {
	private readonly stateDbPath: string;
	private readonly stateDbReader = new CursorStateDbReader((message) => this.log(`${config.logPrefix} ${message}`));
	private readerUnavailableReason: string | null = null;
	private state: ServiceState = {
		enabled: DEFAULT_KEY_FIX_ENABLED,
		running: false,
		activated: false
	};

	private runtime: RuntimeState = {
		pollInterval: null,
		debounceAbort: null,
		initialAbort: null,
		watcher: null,
		watcherSubscriptions: []
	};

	private lastUnavailableReason: string | null = null;
	private lastCheckError: string | null = null;

	constructor(
		context: vscode.ExtensionContext,
		private readonly onStateChange: StateChangeHandler,
		private readonly log: Logger,
		private readonly isLeaderWindow: () => boolean
	) {
		const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
		this.stateDbPath = path.join(globalStorageDir, config.files.stateDb);
	}

	public isEnabled(): boolean {
		if (!this.state.activated) {
			return RuntimeStateStore.read().keyFix.enabled;
		}

		return this.state.enabled;
	}

	public async activate(): Promise<void> {
		this.state.activated = true;
		await this.refreshReaderAvailability();
		const restoredState = RuntimeStateStore.read().keyFix.enabled;

		await this.applySharedState(restoredState);
	}

	public async applySharedState(enabled: boolean): Promise<void> {
		if (!this.state.activated) {
			this.onStateChange(enabled);

			return;
		}

		if (this.state.enabled === enabled) {
			this.onStateChange(enabled);
			this.reconcileMonitoring();

			return;
		}

		if (enabled) {
			await this.enableFromShared();

			return;
		}

		this.disableFromShared();
	}

	public async setEnabledByUser(nextEnabled: boolean): Promise<void> {
		if (nextEnabled) {
			await this.enableByUser();

			return;
		}

		await this.disableByUser();
	}

	/** Turns Cursor's OpenAI API Key switch on once, regardless of whether the auto-fix toggle is on. */
	public async ensureKeyEnabled(): Promise<void> {
		const unavailableReason = await this.refreshReaderAvailability();

		if (unavailableReason) {
			this.log(`${config.logPrefix} cannot enable key: ${unavailableReason}`);

			return;
		}

		try {
			await this.enableOpenAiKeyIfNeeded();
		} catch (error) {
			this.log(`${config.logPrefix} failed to enable key: ${String(error)}`);
		}
	}

	public stop(): void {
		this.state.activated = false;
		this.stopMonitoring();
	}

	private async refreshReaderAvailability(): Promise<string | null> {
		if (!fs.existsSync(this.stateDbPath)) {
			this.readerUnavailableReason = `${config.files.stateDb} not found`;

			return this.readerUnavailableReason;
		}

		this.readerUnavailableReason = await this.stateDbReader.init();

		return this.readerUnavailableReason;
	}

	private startMonitoring(): void {
		if (!this.state.enabled || !this.state.activated || !this.isLeaderWindow()) {
			return;
		}

		if (!this.isKeyFixEnabledInSharedState()) {
			return;
		}

		this.stopMonitoring();
		const globalStorageDir = path.dirname(this.stateDbPath);
		this.runtime.initialAbort = new AbortController();
		const initialSignal = this.runtime.initialAbort.signal;
		void sleep(config.timers.initialCheckMs, initialSignal)
			.then(() => this.checkAndFix())
			.catch(() => {});

		this.runtime.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(globalStorageDir), config.files.stateDbGlob)
		);
		const handleFsEvent = (): void => {
			if (this.runtime.debounceAbort) {
				this.runtime.debounceAbort.abort();
			}

			this.runtime.debounceAbort = new AbortController();
			const debounceSignal = this.runtime.debounceAbort.signal;
			void sleep(config.timers.debounceMs, debounceSignal)
				.then(() => this.checkAndFix())
				.catch(() => {});
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
		if (this.runtime.initialAbort) {
			this.runtime.initialAbort.abort();
			this.runtime.initialAbort = null;
		}

		if (this.runtime.pollInterval) {
			clearInterval(this.runtime.pollInterval);
			this.runtime.pollInterval = null;
		}

		if (this.runtime.debounceAbort) {
			this.runtime.debounceAbort.abort();
			this.runtime.debounceAbort = null;
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

		if (!this.isKeyFixEnabledInSharedState()) {
			this.disableFromShared();

			return;
		}

		if (!this.isLeaderWindow()) {
			return;
		}

		this.state.running = true;

		try {
			const unavailableReason = await this.refreshReaderAvailability();

			if (unavailableReason) {
				if (this.lastUnavailableReason !== unavailableReason) {
					this.lastUnavailableReason = unavailableReason;
					this.log(`${config.logPrefix} monitoring unavailable: ${unavailableReason}`);
				}

				return;
			}

			this.lastUnavailableReason = null;
			await this.enableOpenAiKeyIfNeeded(true);
			this.lastCheckError = null;
		} catch (error) {
			// The poll runs every few seconds; repeat failures with the same cause are logged once.
			const message = String(error);
			if (this.lastCheckError !== message) {
				this.lastCheckError = message;
				this.log(`${config.logPrefix} check failed: ${message}`);
			}
		} finally {
			this.state.running = false;
		}
	}

	private async enableOpenAiKeyIfNeeded(onlyWhenExplicitlyOff = false): Promise<void> {
		const current = await this.readUseOpenAiKey();
		const shouldEnable = onlyWhenExplicitlyOff ? current === false : current !== true;

		if (!shouldEnable) {
			return;
		}

		const reason = onlyWhenExplicitlyOff ? 'key was disabled, re-enabling' : 'enabling OpenAI API Key in Cursor';
		this.log(`${config.logPrefix} ${reason}`);
		await vscode.commands.executeCommand(config.key.toggleCommand);
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
		const raw = await this.stateDbReader.readItemTableValue(this.stateDbPath, config.key.storage);

		if (!raw) {
			return undefined;
		}

		const parsed = JSON.parse(raw) as OpenAiKeyState;

		return parsed.useOpenAIKey;
	}

	private async syncState(enabled: boolean): Promise<void> {
		this.state.enabled = enabled;
		await RuntimeStateStore.mutate((current) => {
			current.keyFix.enabled = enabled;

			return current;
		});
		this.onStateChange(enabled);
	}

	private async enableFromShared(): Promise<void> {
		const unavailableReason = await this.refreshReaderAvailability();

		if (unavailableReason) {
			this.state.enabled = true;
			this.onStateChange(true);
			this.log(`${config.logPrefix} ${unavailableReason}`);
			this.reconcileMonitoring();

			return;
		}

		this.state.enabled = true;
		this.onStateChange(true);
		await this.enableOpenAiKeyIfNeeded();
		this.reconcileMonitoring();
	}

	private disableFromShared(): void {
		this.state.enabled = false;
		this.stopMonitoring();
		this.onStateChange(false);
	}

	private async enableByUser(): Promise<void> {
		const unavailableReason = await this.refreshReaderAvailability();

		if (unavailableReason) {
			throw new Error(unavailableReason);
		}

		await this.syncState(true);

		try {
			await this.enableOpenAiKeyIfNeeded();
		} catch (error) {
			this.log(`${config.logPrefix} failed to enable key: ${String(error)}`);
			throw error;
		}

		this.reconcileMonitoring();
	}

	private isKeyFixEnabledInSharedState(): boolean {
		return RuntimeStateStore.read().keyFix.enabled;
	}

	private isMonitoringActive(): boolean {
		return this.runtime.pollInterval !== null;
	}

	private reconcileMonitoring(): void {
		const shouldMonitor =
			this.state.enabled && this.state.activated && this.isLeaderWindow() && this.isKeyFixEnabledInSharedState();

		if (shouldMonitor === this.isMonitoringActive()) {
			return;
		}

		if (shouldMonitor) {
			this.startMonitoring();

			return;
		}

		this.stopMonitoring();
	}

	private async disableByUser(): Promise<void> {
		await this.syncState(false);
		this.stopMonitoring();
		await this.disableOpenAiKeyIfNeeded();
	}
}
