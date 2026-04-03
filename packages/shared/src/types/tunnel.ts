export interface TunnelState {
	status: 'stopped' | 'installing' | 'starting' | 'running' | 'error';
	url: string | null;
	error: string | null;
}
