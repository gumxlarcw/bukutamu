-- Revert 2026-06-03-wa-display-name.sql.
-- Keputusan desain: identitas (nama & atribut) HANYA boleh bersumber dari DB
-- (hasil isi form / match nomor HP ke tamdes_buku), bukan dari pushname WhatsApp
-- yang self-reported & tak terverifikasi. Kolom display_name tidak dipakai lagi.
ALTER TABLE wa_sessions DROP COLUMN display_name;
