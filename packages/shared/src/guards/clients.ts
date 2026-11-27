import { CLIENT_KINDS, type ClientKind } from '../types/clients';

export function isClientKind(value: unknown): value is ClientKind {
	return typeof value === 'string' && CLIENT_KINDS.includes(value as ClientKind);
}
