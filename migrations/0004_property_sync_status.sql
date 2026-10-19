-- Last live Google sync per property, so failures (e.g. a disabled API) are visible in the UI.
ALTER TABLE property ADD COLUMN last_sync_at TEXT;
ALTER TABLE property ADD COLUMN last_sync_error TEXT;
ALTER TABLE property ADD COLUMN last_sync_ok_at TEXT;
