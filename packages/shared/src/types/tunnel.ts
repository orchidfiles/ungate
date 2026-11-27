import type { TunnelStatus, TunnelWarning } from './runtime';

export interface TunnelState {
	status: TunnelStatus;
	url: string | null;
	error: string | null;
	/** Set while the tunnel runs on a hostname Ungate will not push at the user. */
	warning?: TunnelWarning | null;
}
