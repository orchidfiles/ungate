-- Migration 0008: add configurable request body limit
ALTER TABLE app_settings ADD COLUMN body_limit_mb integer NOT NULL DEFAULT 64;
