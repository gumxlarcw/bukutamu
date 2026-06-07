-- Link-with-phone-number (pairing code) option for the WA connector linking page.
ALTER TABLE wa_qr_state
  ADD COLUMN pair_phone   VARCHAR(32) NULL AFTER number,   -- nomor yg diminta admin utk pairing (digit internasional)
  ADD COLUMN pairing_code VARCHAR(16) NULL AFTER pair_phone; -- kode 8-char dari wwebjs requestPairingCode
