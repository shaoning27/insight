-- Also run this file explicitly for existing data volumes before upgrading the app.
ALTER TABLE insight.ai_hits ADD COLUMN IF NOT EXISTS request_id String DEFAULT '';
ALTER TABLE insight.ai_hits ADD COLUMN IF NOT EXISTS event_hash String DEFAULT '';
