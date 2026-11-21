import { z } from 'zod';

export const runtimeApiStatusSchema = z.enum(['starting', 'running', 'stopped', 'error']);
export const runtimeTunnelStatusSchema = z.enum(['starting', 'running', 'installing', 'stopped', 'error']);
export const runtimeCommandActionSchema = z.enum(['start-tunnel', 'stop-tunnel', 'restart-tunnel', 'restart-api', 'clear-logs']);
export const runtimeLogLevelSchema = z.enum(['info', 'warn', 'error']);

export const runtimeCommandSchema = z.object({
	id: z.string(),
	action: runtimeCommandActionSchema,
	createdAt: z.number(),
	originWindowId: z.string(),
	payload: z
		.object({
			port: z.number().optional(),
			logSource: z.enum(['api', 'tunnel']).optional()
		})
		.optional()
});

export const runtimeClientEntrySchema = z.object({
	lastSeenAt: z.number()
});

export const runtimeApiStateSchema = z.object({
	pid: z.number().nullable(),
	port: z.number().nullable(),
	status: runtimeApiStatusSchema,
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable(),
	startSuppressed: z.boolean().optional()
});

export const runtimeTunnelStateSchema = z.object({
	status: runtimeTunnelStatusSchema,
	url: z.string().nullable(),
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable()
});

export const runtimeKeyFixStateSchema = z.object({
	enabled: z.boolean()
});

export const runtimeAutoTunnelStateSchema = z.object({
	enabled: z.boolean(),
	lastAppliedUrl: z.string().nullable()
});

export const runtimeCursorProviderStateSchema = z.object({
	enabled: z.boolean()
});

export const runtimeStateSchema = z.object({
	api: runtimeApiStateSchema,
	tunnel: runtimeTunnelStateSchema,
	keyFix: runtimeKeyFixStateSchema,
	// State files written before auto-tunnel existed have no `autoTunnel`; the default keeps them parseable.
	autoTunnel: runtimeAutoTunnelStateSchema.default({ enabled: false, lastAppliedUrl: null }),
	// Opt-in for routing requests through the signed-in Cursor session; off unless the user connects.
	cursorProvider: runtimeCursorProviderStateSchema.default({ enabled: false }),
	clients: z.record(z.string(), runtimeClientEntrySchema),
	commands: z.array(runtimeCommandSchema)
});
