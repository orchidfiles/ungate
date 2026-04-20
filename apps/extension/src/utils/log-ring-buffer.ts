export interface LogEntry {
	timestamp: number;
	level: 'info' | 'warn' | 'error';
	message: string;
}

export class LogRingBuffer {
	private readonly buffer: LogEntry[] = [];

	constructor(private readonly maxSize: number) {}

	push(entry: LogEntry): void {
		this.buffer.push(entry);

		if (this.buffer.length > this.maxSize) {
			this.buffer.shift();
		}
	}

	getAll(): LogEntry[] {
		return [...this.buffer];
	}

	clear(): void {
		this.buffer.length = 0;
	}
}
