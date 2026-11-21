-- Which Google connection a meeting's calendar event was made through, fixed when the meeting is first put on a calendar:
--   'oauth'  the organiser's own Google sign-in (calendar_connections, migration 0014)
--   NULL     the older Apps Script bridge (calendar_accounts, migration 0003); every meeting that already exists stays on it
-- It is fixed per meeting because the two can be different Google accounts: an event made by one must be changed by the same one.
ALTER TABLE meetings ADD COLUMN gcal_provider TEXT CHECK (gcal_provider IS NULL OR gcal_provider = 'oauth');
