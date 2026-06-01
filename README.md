# RTRWNET Billing

RTRWNET Billing adalah aplikasi manajemen ISP berbasis Node.js untuk mengelola pelanggan internet, tagihan, pembayaran, portal pelanggan, voucher, teknisi, kolektor, MikroTik, GenieACS, OLT, dan laporan operasional.

Project ini disiapkan agar bisa dipasang dari GitHub tanpa membawa data privat seperti database produksi, session WhatsApp, log, backup, atau konfigurasi rahasia.

## Fitur

- Manajemen pelanggan, paket, invoice, tagihan, dan pembayaran.
- Portal admin, pelanggan, teknisi, agen voucher, dan kolektor.
- Integrasi MikroTik untuk PPPoE, hotspot voucher, isolir, aktivasi kembali, monitoring, dan usage.
- Integrasi GenieACS untuk monitoring CPE/ONU, baca parameter, reboot, ubah SSID/password, dan pengelolaan TR-069.
- Monitoring OLT/ONU, peta pelanggan, ODP, tiket gangguan, dan inventaris.
- Notifikasi melalui WhatsApp, Telegram, dan push notification bila dikonfigurasi.
- Payment gateway dan pembayaran manual sesuai konfigurasi.
- Cron operasional untuk reminder tagihan, isolir, sinkronisasi usage, FUP, dan tugas berkala lain.

## Kebutuhan

- Linux server, disarankan Ubuntu/Debian/Armbian.
- Node.js `>=20`.
- Git.
- SQLite melalui package `better-sqlite3`.
- Build tools untuk dependency native Node.js.
- PM2 untuk menjalankan aplikasi di production.
- MikroTik, GenieACS, OLT, WhatsApp gateway, dan payment gateway bersifat opsional sesuai kebutuhan.

## Instalasi Cepat

```bash
sudo apt update
sudo apt install -y git curl build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Clone repository:

```bash
cd /opt
sudo git clone https://github.com/Agf1611/billing.git billing-rtrw
sudo chown -R "$USER:$USER" /opt/billing-rtrw
cd /opt/billing-rtrw
npm install --no-audit --no-fund
```

Jalankan manual untuk tes:

```bash
npm start
```

Lalu buka:

```text
http://IP-SERVER:3001/admin/login
```

Login awal instalasi:

```text
Username: admin
Password: admin123
```

Setelah login pertama, buka menu pengaturan dan segera ganti password admin, `session_secret`, identitas ISP, serta integrasi yang dibutuhkan. Perubahan dari halaman pengaturan akan disimpan ke `settings.local.json`.

Pada boot pertama, aplikasi akan membuat `settings.local.json` otomatis untuk secret internal dasar. Jadi pengguna baru tidak perlu mengisi secret lewat SSH hanya agar aplikasi bisa start.

Jika sudah berjalan, jalankan dengan PM2:

```bash
pm2 start app-customer.js --name billing-rtrw
pm2 save
pm2 startup
```

Panduan production lebih lengkap ada di [docs/INSTALL_FROM_GITHUB.md](docs/INSTALL_FROM_GITHUB.md).

## Konfigurasi

Aplikasi memakai dua file konfigurasi:

- `settings.json` adalah template publik yang aman ikut GitHub.
- `settings.local.json` adalah konfigurasi privat server dan tidak boleh di-commit.

Pada instalasi baru, aplikasi bisa langsung dijalankan memakai template publik. Login awal hanya aktif selama `admin_password` masih placeholder `CHANGE_ME...`. Setelah password admin diganti dari halaman pengaturan, login default `admin / admin123` otomatis tidak berlaku lagi.

Nilai penting yang perlu diganti di `settings.local.json`:

- `server_port`
- `session_secret`
- `admin_username`
- `admin_password`
- `admin_api_key`
- `genieacs_url`
- `mikrotik_host`
- `mikrotik_user`
- `mikrotik_password`

Konfigurasi opsional:

- WhatsApp gateway. Mode lokal aktif secara default agar QR bisa langsung muncul di menu WhatsApp; nonaktifkan dari Pengaturan bila tidak dipakai.
- Telegram bot
- Tripay, Midtrans, Xendit, Duitku, atau QRIS statis
- OLT/SNMP
- TR-069 ACS URL
- Push notification
- Logo, alamat, kontak, rekening manual, dan identitas ISP

Jangan menyimpan password, token, API key, database produksi, atau session WhatsApp di file yang ikut GitHub.

## Akses Portal

Port default adalah `3001`, mengikuti nilai `server_port` di `settings.local.json`.

- Beranda: `http://IP-SERVER:3001/`
- Admin: `http://IP-SERVER:3001/admin/login`
- Pelanggan: `http://IP-SERVER:3001/customer/login`
- Teknisi: `http://IP-SERVER:3001/tech/login`
- Agen: `http://IP-SERVER:3001/agent/login`
- Kolektor: `http://IP-SERVER:3001/collector/login`
- Health check: `http://IP-SERVER:3001/health`

## Struktur Data Runtime

Folder dan file berikut dibuat/dipakai saat aplikasi berjalan dan tidak disimpan di GitHub:

- `settings.local.json`
- `database/`
- `data/`
- `auth_info_baileys/`
- `logs/`
- `backups/`
- `public/uploads/`
- `tmp/`

Jika memindahkan server, backup folder runtime tersebut sesuai kebutuhan.

## Update

Untuk server yang dipasang dari GitHub:

```bash
cd /opt/billing-rtrw
sudo bash update.sh
```

Script update akan mengambil source terbaru, menjaga data runtime lokal, menjalankan validasi dasar, lalu restart PM2 jika proses ditemukan.

## Pengembangan

Mode development:

```bash
npm run dev
```

Validasi source:

```bash
npm run qa
```

Perintah `npm run qa` menjalankan:

- syntax check JavaScript
- smoke render EJS
- smoke test route/core
- static scan

Audit sebelum publish:

```bash
npm run audit:publish
```

Audit ini memastikan file privat, database, backup, log, file sementara, dan arsip deploy tidak ikut repository.

## Keamanan

- Ganti semua nilai `CHANGE_ME...` sebelum production.
- Gunakan `session_secret` acak minimal 32 karakter.
- Gunakan password admin yang kuat.
- Jangan commit `settings.local.json`, `.env`, database, log, backup, session WhatsApp, atau file deploy pribadi.
- Batasi akses panel admin menggunakan firewall, VPN, reverse proxy, atau proteksi tambahan sesuai kebutuhan.
- Jalankan `npm run audit:publish` sebelum push ke GitHub.

## Lisensi

ISC. Lihat [LICENSE](LICENSE).
