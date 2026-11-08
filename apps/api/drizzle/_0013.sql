-- Migration 0013: Cursor tool schema mode per model mapping; last detected subscription tier per account
ALTER TABLE model_mappings ADD COLUMN tool_mode text;
--> statement-breakpoint
ALTER TABLE oauth_accounts ADD COLUMN plan_type text;
