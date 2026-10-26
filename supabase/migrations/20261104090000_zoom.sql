-- Zoom (F1.07, C1.02, C2.04): one connected Zoom account per organisation, a meeting per online session,
-- attendance imported after each meeting.

-- Tokens are encrypted by the API (AES-256-GCM) before they are stored; Vault isn't needed.
alter table public.zoom_connections
  alter column refresh_token_secret_id drop not null,
  add column if not exists refresh_token_enc text,
  add column if not exists access_token_enc text,
  add column if not exists access_token_expires_at timestamptz;

-- zoom_managed: Synqop created the meeting (a pasted link is left alone).
-- zoom_sync_needed: the session's time changed; the meeting is updated on the next run.
alter table public.sessions
  add column if not exists zoom_managed boolean not null default false,
  add column if not exists zoom_sync_needed boolean not null default false,
  add column if not exists zoom_sync_error text,
  add column if not exists zoom_import_error text;
