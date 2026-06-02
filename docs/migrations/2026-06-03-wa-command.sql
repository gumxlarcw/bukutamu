-- Admin → connector command channel (read-once via /api/wa/poll). e.g. 'logout' to unlink & re-scan.
ALTER TABLE wa_qr_state ADD COLUMN command VARCHAR(20) NULL AFTER ready;
