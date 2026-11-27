-- Migration 0017: per-client keys for the model routes, and the calling client on each request.
-- The key in app_settings.api_key (the one pasted into Cursor) becomes client `cursor`; its value stays
-- in app_settings, so this table never holds it. Minted clients store only a SHA-256 of their key.
CREATE TABLE IF NOT EXISTS `client_keys` (
 `id` text PRIMARY KEY NOT NULL,
 `kind` text NOT NULL,
 `label` text NOT NULL,
 `key_hash` text,
 `created_at` integer NOT NULL,
 `revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_keys_key_hash_idx` ON `client_keys` (`key_hash`);
--> statement-breakpoint
INSERT OR IGNORE INTO client_keys (id, kind, label, key_hash, created_at, revoked_at)
VALUES ('cursor', 'settings', 'cursor', NULL, CAST(strftime('%s', 'now') AS integer) * 1000, NULL);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN client_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `requests_client_timestamp_idx` ON `requests` (`client_id`, `timestamp`);
