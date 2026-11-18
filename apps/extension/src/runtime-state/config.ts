import * as os from 'node:os';
import * as path from 'node:path';

const baseDir = path.join(os.homedir(), '.ungate');

export const config = {
	baseDir,
	paths: {
		stateFilePath: path.join(baseDir, 'runtime-state.json'),
		lockPath: path.join(baseDir, 'runtime-state.lock'),
		sharedLogPath: path.join(baseDir, 'extension.log')
	},
	runtimeState: {
		// Max age for a client heartbeat before the window is considered stale.
		staleClientMs: 5000,
		// Max time to wait for lock acquisition before forcing lock recovery.
		lockTimeoutMs: 1500,
		// Minimum interval between heartbeat writes for the same window.
		heartbeatThrottleMs: 2000
	},
	apiServer: {
		// Interval between API /health checks while process is running.
		healthCheckIntervalMs: 1000,
		// Grace period before stopping API when no live windows remain.
		noClientsGracePeriodMs: 3000,
		// Delay before spawning API again after restart/clean exit.
		restartDelayMs: 500,
		// Request timeout for periodic API health checks.
		healthCheckRequestTimeoutMs: 2000,
		// Consecutive missed /health probes before the API is treated as down.
		// A miss does not latch startSuppressed; the leader may start the API again.
		healthCheckFailureLimit: 3,
		// Request timeout used when validating an existing API port.
		portHealthRequestTimeoutMs: 1500,
		// Another window's `starting` state is left alone until this age.
		startingStateTimeoutMs: 10000
	},
	tunnelManager: {
		// Interval for checking if tunnel should auto-stop without live windows.
		autoStopCheckIntervalMs: 1500
	},
	extensionController: {
		// Interval between heartbeat updates from the current window.
		heartbeatIntervalMs: 2000,
		// Interval for pulling shared runtime state and syncing UI/actions.
		runtimeSyncIntervalMs: 2000,
		// Max wait time for tunnel URL while startup is in progress.
		tunnelWaitTimeoutMs: 30000,
		// Poll interval while waiting for tunnel URL readiness.
		tunnelWaitPollIntervalMs: 250
	},
	openAiKeyFix: {
		// Delay before first key-fix check after monitor startup.
		initialCheckMs: 3000,
		// Debounce delay for filesystem-triggered key-fix checks.
		debounceMs: 1000,
		// Periodic polling interval for key-fix consistency checks.
		pollMs: 5000
	}
};
