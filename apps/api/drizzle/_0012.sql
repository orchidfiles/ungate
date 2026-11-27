CREATE TABLE IF NOT EXISTS `oauth_accounts` (
 `id` text PRIMARY KEY NOT NULL,
 `provider` text NOT NULL,
 `label` text NOT NULL,
 `email` text,
 `provider_user_id` text,
 `provider_account_id` text,
 `access_token` text NOT NULL,
 `refresh_token` text,
 `expires_at` integer,
 `credential_version` integer DEFAULT 1 NOT NULL,
 `created_at` integer NOT NULL,
 `updated_at` integer NOT NULL,
 `cooldown_until` integer,
 `cooldown_reason` text,
 `cooldown_estimated` integer DEFAULT false NOT NULL,
 `needs_login` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_policies` (
 `provider` text PRIMARY KEY NOT NULL,
 `active_account_id` text,
 `auto_switch` integer DEFAULT true NOT NULL,
 `revision` integer DEFAULT 0 NOT NULL,
 `last_switch_reason` text
);
--> statement-breakpoint
INSERT OR IGNORE INTO oauth_accounts
(id, provider, label, email, provider_account_id, access_token, refresh_token, expires_at, created_at, updated_at)
SELECT 'legacy-' || provider, provider, COALESCE(email, provider || ' account'), email, account_id,
access_token, refresh_token, expires_at, created_at, created_at
FROM provider_settings WHERE provider IN ('claude', 'openai');
--> statement-breakpoint
INSERT OR IGNORE INTO oauth_policies (provider, active_account_id)
SELECT provider, id FROM oauth_accounts WHERE id = 'legacy-' || provider;
--> statement-breakpoint
INSERT OR IGNORE INTO oauth_policies (provider) VALUES ('claude'), ('openai');
--> statement-breakpoint
DELETE FROM provider_settings WHERE provider IN ('claude', 'openai') AND EXISTS
(SELECT 1 FROM oauth_accounts WHERE id = 'legacy-' || provider_settings.provider);
