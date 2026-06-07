-- Tambah 'group_notify' ke ENUM wa_outbox.msg_type — notifikasi ke GRUP WhatsApp petugas.
-- (ENUM gotcha: nilai baru WAJIB lewat ALTER, sama seperti admin_users.role.)
ALTER TABLE wa_outbox MODIFY COLUMN msg_type
  ENUM('intake_link','confirmation','eval_link','thankyou','group_notify') NOT NULL;
