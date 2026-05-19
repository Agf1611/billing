# Perbandingan Source Lokal vs `alijayanet/billing-rtrw`

## Lokasi pembanding

- Source lokal: `C:\xampp\htdocs\billing`
- Repo pembanding: `C:\xampp\htdocs\billing\billing-rtrw-alijayanet`

## Ringkasan cepat

Secara umum, source lokal Anda **lebih kaya fitur** dan sudah banyak dikustom:

- modul QRIS
- push notification
- public link/invoice helper
- session store SQLite
- runtime safety
- security hardening
- customer detail service yang lebih lengkap
- route admin yang sudah dipecah ke beberapa file
- QA script tambahan

Sementara repo Alijaya terlihat **lebih sederhana di beberapa area**, tetapi ada beberapa pola yang memang berpotensi lebih stabil, terutama pada:

- koneksi MikroTik
- validasi dan audit perubahan settings
- beberapa modul admin tambahan yang masih terpisah rapi

## Temuan penting

### 1. Area yang source lokal Anda sudah lebih maju

Contoh file:

- `config/security.js`
- `config/runtimeSafety.js`
- `config/sqliteSessionStore.js`
- `services/qrisService.js`
- `services/publicLinkService.js`
- `services/pushNotificationService.js`
- `services/customerDetailService.js`
- `routes/admin/registerBillingRoutes.js`
- `routes/admin/registerCustomerRoutes.js`
- `routes/admin/registerWhatsappRoutes.js`
- `scripts/check-syntax.js`
- `scripts/smoke-core.js`
- `scripts/smoke-render.js`
- `scripts/static-scan.js`

Kesimpulan:

- Dari sisi keamanan aplikasi web, source lokal justru lebih baik.
- Dari sisi maintainability route admin, source lokal lebih sehat karena sudah mulai dipecah.
- Dari sisi fitur pelanggan dan pembayaran, source lokal jauh lebih lengkap.

### 2. Area yang repo Alijaya terlihat lebih stabil

Contoh file:

- `billing-rtrw-alijayanet/services/mikrotikService.js`
- `billing-rtrw-alijayanet/config/settingsValidator.js`
- `billing-rtrw-alijayanet/config/settingsEncryption.js`
- `billing-rtrw-alijayanet/config/settingsAudit.js`

Poin bagus dari repo Alijaya:

- Ada cache koneksi/list untuk request MikroTik.
- Ada TCP probe port 8728/8729 sebelum connect.
- Ada timeout wrapper untuk operasi RouterOS tertentu.
- Ada invalidasi cache setelah create/update/delete data hotspot/PPPoE.
- Ada validasi field settings sebelum disimpan.
- Ada audit perubahan settings.
- Ada masking/enkripsi field sensitif di settings.

Kesimpulan:

- Kalau masalah utama Anda adalah sistem terasa tidak stabil saat akses MikroTik, bagian yang paling layak diadopsi dulu adalah pola di `services/mikrotikService.js`.
- Kalau masalahnya sering ada salah input setting atau config rusak, maka `settingsValidator` dan `settingsAudit` dari repo Alijaya juga layak diambil.

### 3. Area yang repo Alijaya justru lebih sederhana, bukan otomatis lebih baik

Contoh file:

- `billing-rtrw-alijayanet/app-customer.js`
- `billing-rtrw-alijayanet/routes/adminPortal.js`

Catatan:

- `app-customer.js` versi Alijaya lebih pendek, tetapi source lokal Anda punya session handling, cookie config, safe redirect, runtime warning, dan helper tambahan yang lebih matang.
- `routes/adminPortal.js` versi Alijaya lebih monolitik; source lokal Anda lebih besar karena banyak fitur, tetapi arah pemecahan route di lokal sebenarnya lebih baik untuk jangka panjang.

Kesimpulan:

- Saya tidak menyarankan mengganti total `app-customer.js` atau `routes/adminPortal.js` dengan versi Alijaya.
- Lebih aman ambil pola tertentu saja, bukan overwrite penuh.

## File/modul yang hanya ada di source lokal

Beberapa yang paling menonjol:

- `services/bookkeepingService.js`
- `services/customerDetailService.js`
- `services/packageChangeService.js`
- `services/phoneService.js`
- `services/publicLinkService.js`
- `services/pushNotificationService.js`
- `services/qrisService.js`
- `config/security.js`
- `config/runtimeSafety.js`
- `config/sqliteSessionStore.js`

## File/modul yang hanya ada di repo Alijaya

Beberapa yang paling menonjol:

- `services/attendanceService.js`
- `services/payrollService.js`
- `services/sidebarMenuService.js`
- `config/settingsValidator.js`
- `config/settingsEncryption.js`
- `config/settingsAudit.js`
- `middleware/attendanceUpload.js`
- `routes/acsPortal.js`
- `routes/financePortal.js`

## Rekomendasi implementasi paling aman

Urutan terbaik menurut saya:

1. Ambil pola stabilitas dari `billing-rtrw-alijayanet/services/mikrotikService.js` ke source lokal, tapi merge hati-hati karena source lokal punya fitur monitoring yang lebih kaya.
2. Tambahkan `settingsValidator` ke flow simpan settings lokal.
3. Tambahkan `settingsAudit` untuk jejak perubahan settings.
4. Evaluasi apakah `settingsEncryption` ingin dipakai penuh, karena ini butuh strategi migrasi agar settings lama tidak rusak.

## Yang tidak saya sarankan langsung

- overwrite penuh `app-customer.js`
- overwrite penuh `routes/adminPortal.js`
- overwrite penuh `views/admin/mikrotik.ejs`
- overwrite penuh `services/customerDetailService.js`

Alasannya:

- risiko bentrok dengan custom fitur Anda tinggi
- source lokal punya banyak penambahan yang tidak ada di repo Alijaya
- hasilnya bisa menurunkan fitur walaupun terlihat lebih sederhana

## Kandidat implementasi tahap 1

Kalau mau mulai dari yang paling terasa dampaknya, saya sarankan fokus ke:

- hardening `services/mikrotikService.js`
- validasi save settings
- audit perubahan settings

## Status clone

Repo pembanding sudah berhasil di-clone ke:

- `C:\xampp\htdocs\billing\billing-rtrw-alijayanet`
