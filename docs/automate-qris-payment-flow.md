# Flow Automate QRIS Payment Notif

Dokumen ini adalah versi lengkap flow Automate untuk membaca notifikasi pembayaran dari HP lalu mengirimkannya ke webhook aplikasi SICKAS.

Target utama:
- Tidak mudah bengong karena filter terlalu sempit.
- Tidak memblokir notifikasi valid yang berisi kata `kode`.
- Mengirim data lengkap ke server, biar server yang mencocokkan nominal kode unik.
- Ada retry dan log sederhana kalau internet HP sedang lemah.

## Endpoint

Gunakan endpoint utama:

```text
https://pay.sickas.web.id/api/webhook/v1/payment-notif
```

Jika masih memakai instance billing terpisah, tambahkan endpoint kedua:

```text
https://billing.sickas.web.id/api/webhook/v1/payment-notif
```

Secret harus sama dengan menu admin:

```text
Admin > Settings > Payment Notif Secret
```

Jangan pakai spasi di depan atau belakang secret.

## Permission HP

Di HP yang dipakai baca notifikasi:

- Automate > Settings > Privileges > aktifkan `Notification access`.
- Android Settings > Battery > Automate > pilih `Unrestricted` atau `Tidak dibatasi`.
- Matikan battery saver untuk Automate.
- Izinkan data background untuk Automate.
- Jangan kunci aplikasi DANA/BRImo dari menampilkan notifikasi.
- Jika ada fitur Auto start / App launch di HP, izinkan Automate berjalan otomatis.

## Struktur Flow

### 1. Flow beginning

Nama:

```text
QRIS Payment Notif Webhook
```

Parallel launch:

```text
Off
```

Lanjut ke block `Notification posted`.

### 2. Notification posted

Block:

```text
Notification posted
```

Proceed:

```text
When transition
```

Package:

```text
kosongkan
```

Kenapa dikosongkan:
- Notifikasi QRIS bisa muncul dari DANA, BRImo, BRI, mobile banking, atau aplikasi lain.
- Server akan mencocokkan nominal, jadi flow tidak perlu terlalu pilih-pilih aplikasi.

Exclude flags:

```text
Group summary
```

Output variable:

```text
Package      = pkg
Title        = notifTitle
Message      = notifMsg
Extras       = notifExtras
Addition texts = notifTexts
```

Lanjut ke block `Variable set: content`.

### 3. Variable set: content

Block:

```text
Variable set
```

Variable:

```text
content
```

Value:

```text
trim(
  coalesce(pkg, "") ++ "\n" ++
  coalesce(notifTitle, "") ++ "\n" ++
  coalesce(notifMsg, "") ++ "\n" ++
  coalesce(notifExtras["android.title"], "") ++ "\n" ++
  coalesce(notifExtras["android.text"], "") ++ "\n" ++
  coalesce(notifExtras["android.bigText"], "") ++ "\n" ++
  join(coalesce(notifTexts, []), "\n")
)
```

Catatan:
- Kalau Automate di HP tidak menerima `notifExtras["android.bigText"]`, hapus baris extras dan pakai versi simpel:

```text
trim(coalesce(pkg, "") ++ "\n" ++ coalesce(notifTitle, "") ++ "\n" ++ coalesce(notifMsg, ""))
```

Lanjut ke block `Variable set: contentLower`.

### 4. Variable set: contentLower

Block:

```text
Variable set
```

Variable:

```text
contentLower
```

Value:

```text
lowerCase(content)
```

Lanjut ke block `Expression true: ada nominal`.

### 5. Expression true: ada nominal

Block:

```text
Expression true?
```

Expression:

```text
matches(contentLower, "(?s).*(rp\\.?\\s*[0-9]|idr\\s*[0-9]).*")
```

YES lanjut ke `Expression true: indikasi uang masuk`.

NO kembali ke `Notification posted`.

Catatan:
- Jangan pakai filter angka bebas seperti `[0-9][0-9][0-9][0-9]`.
- Notifikasi PPPoE, tanggal, jam, atau username bisa punya angka 4 digit dan nanti salah dianggap pembayaran.

### 6. Expression true: indikasi uang masuk

Block:

```text
Expression true?
```

Expression:

```text
matches(contentLower, "(?s).*(masuk|diterima|menerima|terima uang|saldo bertambah|uang masuk|dana masuk|qris masuk|pembayaran diterima|kredit|credit|transfer dari).*")
```

YES lanjut ke `Expression true: bukan transaksi keluar`.

NO kembali ke `Notification posted`.

### 7. Expression true: bukan transaksi keluar

Block:

```text
Expression true?
```

Expression:

```text
!matches(contentLower, "(?s).*(transfer ke|dikirim ke|terkirim|saldo berkurang|top up|topup|isi saldo|pembelian|belanja|bayar ke|pembayaran ke|tarik saldo|withdraw|gagal|dibatalkan).*")
```

YES lanjut ke `Expression true: bukan promo`.

NO kembali ke `Notification posted`.

### 8. Expression true: bukan promo

Block:

```text
Expression true?
```

Expression:

```text
!matches(contentLower, "(?s).*(promo|diskon|cashback|klaim|voucher|otp|tagihan|pengingat|pppoe|hotspot|mikrotik|router|telegram|whatsapp).*")
```

YES lanjut ke `Variable set: payloadPay`.

NO kembali ke `Notification posted`.

Penting:
- Jangan masukkan kata `kode` ke blacklist.
- Sistem kode unik bisa saja membaca notifikasi yang berisi kata kode.

### 9. Variable set: payloadPay

Block:

```text
Variable set
```

Variable:

```text
payloadPay
```

Value:

```text
{
  "secret_key": "ISI_SECRET_PAYMENT_NOTIF",
  "service": coalesce(pkg, "NOTIFICATION"),
  "title": coalesce(notifTitle, ""),
  "text": coalesce(notifMsg, ""),
  "message": coalesce(notifMsg, ""),
  "content": content,
  "appName": coalesce(pkg, ""),
  "package": coalesce(pkg, ""),
  "source": "Automate"
}
```

Ganti:

```text
ISI_SECRET_PAYMENT_NOTIF
```

dengan secret di menu admin.

Lanjut ke `Variable set: retryPay`.

### 10. Variable set: retryPay

Variable:

```text
retryPay
```

Value:

```text
0
```

Lanjut ke `HTTP request: pay`.

### 11. HTTP request: pay

Block:

```text
HTTP request
```

Request URL:

```text
https://pay.sickas.web.id/api/webhook/v1/payment-notif
```

Request method:

```text
POST
```

Request content type:

```text
application/json
```

Request content body:

```text
jsonEncode(payloadPay)
```

Request headers:

```text
{
  "Content-Type": "application/json",
  "x-webhook-secret": "ISI_SECRET_PAYMENT_NOTIF"
}
```

Timeout:

```text
20s
```

Output variables:

```text
Response status code = statusPay
Response content     = responsePay
Response headers     = headersPay
```

Kalau Automate menyediakan lane Failure, arahkan Failure ke `Pay retry check`.

OK lanjut ke `Expression true: pay sukses`.

### 12. Expression true: pay sukses

Expression:

```text
statusPay >= 200 && statusPay < 300
```

YES lanjut ke `Toast: terkirim`.

NO lanjut ke `Pay retry check`.

### 13. Pay retry check

Block:

```text
Expression true?
```

Expression:

```text
retryPay < 3
```

YES lanjut ke `Variable set: retryPay + 1`.

NO lanjut ke `Toast: gagal`.

### 14. Variable set: retryPay + 1

Variable:

```text
retryPay
```

Value:

```text
retryPay + 1
```

Lanjut ke `Delay: retry`.

### 15. Delay: retry

Block:

```text
Delay
```

Duration:

```text
10s
```

Lanjut kembali ke `HTTP request: pay`.

### 16. Toast: terkirim

Block:

```text
Toast show
```

Message:

```text
"Webhook pembayaran terkirim: " ++ statusPay
```

Lanjut ke `Log append: sukses` jika mau pakai log, atau langsung kembali ke `Notification posted`.

### 17. Toast: gagal

Block:

```text
Toast show
```

Message:

```text
"Webhook pembayaran gagal: " ++ coalesce(statusPay, "no status")
```

Lanjut kembali ke `Notification posted`.

## Endpoint Kedua: billing.sickas.web.id

Jika dua server sama-sama harus menerima notifikasi, duplikasi block 9 sampai 17 untuk endpoint:

```text
https://billing.sickas.web.id/api/webhook/v1/payment-notif
```

Gunakan secret sesuai setting server billing.

Kalau tidak yakin, lebih aman kirim ke satu endpoint utama saja:

```text
https://pay.sickas.web.id/api/webhook/v1/payment-notif
```

## Test Cepat

Di Automate, buat satu flow test sementara yang langsung HTTP request tanpa menunggu notifikasi.

Body:

```text
jsonEncode({
  "secret_key": "ISI_SECRET_PAYMENT_NOTIF",
  "service": "TEST",
  "title": "DANA",
  "text": "Uang masuk Rp 120.123",
  "content": "DANA Uang masuk Rp 120.123",
  "source": "Automate Test"
})
```

Kalau sukses, endpoint akan membalas JSON `processed`.

## Pola Yang Sengaja Tidak Dipakai

Jangan pakai filter seperti ini:

```text
.*(dana|brimo|bri).*
```

sebagai syarat utama, karena bisa gagal kalau nama aplikasi berbeda atau huruf besar kecil tidak sama.

Jangan blacklist kata:

```text
kode
```

karena sistem pembayaran kode unik bisa ikut terblokir.

## Alur Ringkas

```text
Flow beginning
  -> Notification posted
  -> Gabung title/message/extras jadi content
  -> lowerCase(content)
  -> Cek ada nominal
  -> Cek indikasi uang masuk
  -> Cek bukan transaksi keluar
  -> Cek bukan promo
  -> POST webhook
  -> Jika gagal retry 3x
  -> Kembali tunggu notifikasi
```
