# Install From GitHub

Panduan ini untuk memasang aplikasi dari repository publik:

```bash
https://github.com/Agf1611/billing.git
```

## Kebutuhan Server

- Ubuntu/Debian/Armbian yang masih mendapat update keamanan
- Node.js 20 atau lebih baru
- Git
- Build tools untuk dependency native `better-sqlite3`
- PM2 untuk menjalankan aplikasi di background

Contoh instalasi dependency dasar:

```bash
sudo apt update
sudo apt install -y git curl build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## Clone Source

```bash
sudo mkdir -p /opt
sudo chown "$USER:$USER" /opt
cd /opt
git clone https://github.com/Agf1611/billing.git billing-rtrw
cd billing-rtrw
npm install --no-audit --no-fund
```

## Konfigurasi

Jangan isi secret asli di `settings.json`. File itu hanya template publik.

Buat konfigurasi lokal:

```bash
cp settings.json settings.local.json
nano settings.local.json
```

Minimal yang perlu diganti:

- `server_port`
- `session_secret`
- `admin_username`
- `admin_password`
- `admin_api_key`
- `genieacs_url`
- `mikrotik_host`
- `mikrotik_user`
- `mikrotik_password`

Jika memakai WhatsApp, payment gateway, Telegram, TR-069, atau OLT, isi kredensialnya hanya di `settings.local.json`.

## Menjalankan Aplikasi

Tes manual dulu:

```bash
npm start
```

Jika sudah bisa dibuka, jalankan dengan PM2:

```bash
pm2 start app-customer.js --name billing-rtrw
pm2 save
pm2 startup
```

Ikuti perintah tambahan yang ditampilkan oleh `pm2 startup`.

## Update Dari GitHub

Di server yang sudah terpasang:

```bash
cd /opt/billing-rtrw
sudo bash update.sh
```

Script `update.sh` akan:

- membaca remote GitHub dari repository yang sedang dipakai
- backup runtime lokal
- pull update terbaru dari GitHub
- install dependency
- menjalankan smoke check
- restart PM2 jika nama proses sama dengan nama folder

Data yang dipreservasi saat update:

- `settings.local.json`
- `database/`
- `auth_info_baileys/`
- `logs/`
- `public/uploads/`

## Sebelum Push Ke GitHub

Jalankan:

```bash
npm run audit:publish
npm run qa
```

Jangan commit:

- `settings.local.json`
- `.env`
- database produksi
- session WhatsApp
- file backup
- log
- folder `tmp/`
- file `tmp_*` atau `tmp-*`
- arsip deploy seperti `.tar.gz`, `.tgz`, dan `.zip`
