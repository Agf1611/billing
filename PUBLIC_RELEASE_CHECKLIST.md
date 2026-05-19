# Public Release Checklist

Gunakan checklist ini sebelum source dibagikan ke orang lain.

## Wajib lulus

- `npm run qa`
- `npm run audit:publish`

## Konfigurasi

- `settings.json` hanya berisi template aman.
- `settings.local.json` tidak ikut commit atau paket rilis.
- Semua password, token, dan API key asli hanya ada di server atau file privat.

## File rilis

- Tidak ada skrip deploy internal yang tersisa di tracked files.
- Tidak ada backup runtime, log, database produksi, atau auth session yang ikut paket.
- Paket rilis dibuat dari tracked files yang sudah lolos audit, bukan dari seluruh folder kerja lokal.

## Keamanan aplikasi

- Login admin memakai password kuat.
- `session_secret` minimal 32 karakter acak.
- Gateway pembayaran, WhatsApp, Telegram, MikroTik, dan GenieACS memakai kredensial non-default.
- Endpoint publik dasar tetap lolos smoke test setelah hardening.

## Dokumentasi

- README sudah menjelaskan `settings.json` vs `settings.local.json`.
- Instruksi instalasi dan startup masih akurat.
- Catatan publish dan audit sudah dicantumkan.

## Opsional tapi disarankan

- Review hasil `scan:static` dan kurangi penggunaan render HTML mentah.
- Buat branch/tag khusus rilis publik.
- Uji clone bersih di folder baru untuk memastikan setup dari nol tetap berjalan.
