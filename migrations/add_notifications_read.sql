-- Add 'read' boolean column to notifications table (default false = unread)
-- Run this in Supabase SQL Editor

ALTER TABLE notifications 
  ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT FALSE;
