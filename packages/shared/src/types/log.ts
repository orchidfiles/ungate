export interface LogEntry {
	timestamp: number;
	level: 'info' | 'warn' | 'error';
	message: string;
}
