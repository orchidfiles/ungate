import type {
	DetachedCloudflaredAttach,
	DetachedCloudflaredExit,
	DetachedCloudflaredListener,
	DetachedCloudflaredSpawn
} from '../../../src/detached-cloudflared';

export class FakeDetachedCloudflared {
	public static spawned: FakeDetachedCloudflared[] = [];
	public static starts: DetachedCloudflaredSpawn[] = [];
	public static attachments: DetachedCloudflaredAttach[] = [];
	public static reportedHostname: string | null = null;

	public stopped = 0;
	public attached: DetachedCloudflaredAttach | null = null;
	public pid = 4242;
	public metricsPort = 45000;

	private readonly listener: DetachedCloudflaredListener;

	constructor(listener: DetachedCloudflaredListener) {
		this.listener = listener;
	}

	public getPid(): number | null {
		return this.pid;
	}

	public getMetricsPort(): number | null {
		return this.metricsPort;
	}

	public start(spec: DetachedCloudflaredSpawn): Promise<void> {
		FakeDetachedCloudflared.spawned.push(this);
		FakeDetachedCloudflared.starts.push(spec);

		return Promise.resolve();
	}

	public attach(spec: DetachedCloudflaredAttach): void {
		this.pid = spec.pid;
		this.metricsPort = spec.metricsPort;
		this.attached = spec;
		FakeDetachedCloudflared.attachments.push(spec);
	}

	public stop(): void {
		this.stopped += 1;
	}

	public readQuickTunnelHostname(): Promise<string | null> {
		return Promise.resolve(FakeDetachedCloudflared.reportedHostname);
	}

	public hostnameMatches(recordedUrl: string, reportedHostname: string): boolean {
		const recorded = this.hostnameOf(recordedUrl);
		const reported = this.hostnameOf(reportedHostname);

		if (!recorded || !reported) {
			return false;
		}

		return recorded === reported;
	}

	public emitUrl(url: string): void {
		this.listener.onUrl(url);
	}

	public emitLog(line: string): void {
		this.listener.onLog(line);
	}

	public emitExit(reason = 'Process exited before tunnel was ready'): void {
		const exit: DetachedCloudflaredExit = { reason };
		this.listener.onExit(exit);
	}

	public static reset(): void {
		this.spawned = [];
		this.starts = [];
		this.attachments = [];
		this.reportedHostname = null;
	}

	private hostnameOf(value: string): string | null {
		const trimmed = value.trim();

		if (!trimmed) {
			return null;
		}

		try {
			const hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;

			return hostname.toLowerCase() || null;
		} catch {
			return null;
		}
	}
}
