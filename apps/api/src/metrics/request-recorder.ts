import { Requests } from '../database/requests';

import type { RequestRecord } from '@ungate/shared';

/** Single entry for persisting chat request analytics; add policy or extra sinks here instead of calling `Requests` from many handlers. */
export class RequestRecorder {
	static record(record: RequestRecord, cacheReadTokens?: number, cacheCreationTokens?: number): number {
		return Requests.record(record, cacheReadTokens, cacheCreationTokens);
	}
}
