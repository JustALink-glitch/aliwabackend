-- Add attendance_threshold_percentage column to sessions table if it doesn't exist
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS attendance_threshold_percentage INT DEFAULT 40;
