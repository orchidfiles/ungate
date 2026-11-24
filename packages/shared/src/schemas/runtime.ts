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

/** `offensive-hostname`: the provider assigned a hostname the word filter rejects and it cannot be rerolled. */
export const TUNNEL_WARNINGS = ['offensive-hostname'] as const;

export const runtimeTunnelWarningSchema = z.enum(TUNNEL_WARNINGS);

export const runtimeTunnelStateSchema = z.object({
	status: runtimeTunnelStatusSchema,
	url: z.string().nullable(),
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable(),
	// State files written before hostname screening have no `warning`.
	warning: runtimeTunnelWarningSchema.nullable().default(null)
});

export const runtimeKeyFixStateSchema = z.object({
	enabled: z.boolean()
});

export const runtimeAutoTunnelStateSchema = z.object({
	enabled: z.boolean(),
	lastAppliedUrl: z.string().nullable()
});

/** `quick` is the Cloudflare quick tunnel. `ngrok` keeps one account dev domain across restarts. */
export const TUNNEL_PROVIDERS = ['quick', 'ngrok'] as const;

export const runtimeTunnelProviderSchema = z.enum(TUNNEL_PROVIDERS);

export const runtimeStateSchema = z.object({
	api: runtimeApiStateSchema,
	tunnel: runtimeTunnelStateSchema,
	keyFix: runtimeKeyFixStateSchema,
	// State files written before auto-tunnel existed have no `autoTunnel`; the default keeps them parseable.
	autoTunnel: runtimeAutoTunnelStateSchema.default({ enabled: false, lastAppliedUrl: null }),
	// State files written before ngrok existed have no `tunnelProvider`; quick keeps their rotating URL.
	tunnelProvider: runtimeTunnelProviderSchema.default('quick'),
	// Optional domain the user owns at ngrok, passed as `--url`. Null keeps the account's dev domain.
	ngrokDomain: z.string().nullable().default(null),
	clients: z.record(z.string(), runtimeClientEntrySchema),
	commands: z.array(runtimeCommandSchema)
});
