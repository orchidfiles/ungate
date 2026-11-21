-- Migration 0012: per-request usage telemetry (account pool, cache split, reasoning, agent sessions)
ALTER TABLE requests ADD COLUMN account_id text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN attempts integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN rotation_reason text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN cache_read_tokens integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN cache_creation_tokens integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN reasoning_tokens integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN reasoning_chars integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN reasoning_tier text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN stop_reason text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN tool_call_count integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN tool_names text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN session_key text;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN turn_index integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN message_count integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN continuation integer;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN first_token_ms integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS requests_timestamp_idx ON requests (timestamp);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS requests_session_key_idx ON requests (session_key, timestamp);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS requests_account_timestamp_idx ON requests (account_id, timestamp);
