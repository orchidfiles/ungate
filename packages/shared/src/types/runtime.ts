import type {
	runtimeApiStateSchema,
	runtimeAutoTunnelStateSchema,
	runtimeApiStatusSchema,
	runtimeClientEntrySchema,
	runtimeCommandActionSchema,
	runtimeCommandSchema,
	runtimeLogLevelSchema,
	runtimeStateSchema,
	runtimeTunnelStateSchema,
	runtimeTunnelStatusSchema
} from '../schemas/runtime';
import type { z } from 'zod';

export type ApiStatus = z.infer<typeof runtimeApiStatusSchema>;
export type TunnelStatus = z.infer<typeof runtimeTunnelStatusSchema>;
export type RuntimeCommandAction = z.infer<typeof runtimeCommandActionSchema>;
export type LogLevel = z.infer<typeof runtimeLogLevelSchema>;
export type RuntimeClientEntry = z.infer<typeof runtimeClientEntrySchema>;
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;
export type RuntimeApiState = z.infer<typeof runtimeApiStateSchema>;
export type RuntimeTunnelState = z.infer<typeof runtimeTunnelStateSchema>;
export type RuntimeAutoTunnelState = z.infer<typeof runtimeAutoTunnelStateSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
