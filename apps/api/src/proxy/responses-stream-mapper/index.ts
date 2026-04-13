import { ResponsesSseProcessor } from './process-responses-chunk';
import { StreamDiagnostics } from './stream-diagnostics';
import { StreamStateFactory, type StreamState } from './stream-state';

export type { StreamProcessResult, StreamState } from './stream-state';
export { ResponsesSseProcessor };
export { StreamStateFactory };
export { StreamDiagnostics };

export class ResponsesStreamMapper {
	static createState(model: string): StreamState {
		return StreamStateFactory.create(model);
	}

	static processChunk(state: StreamState, chunk: string) {
		return ResponsesSseProcessor.process(state, chunk);
	}

	static logFinished(state: StreamState, how: 'stream' | 'buffer'): void {
		StreamDiagnostics.logFinished(state, how);
	}
}
