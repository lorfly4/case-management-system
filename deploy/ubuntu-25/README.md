# Deployment Ubuntu 25.x

Panduan ini menjalankan aplikasi sebagai service `systemd`, dengan Nginx sebagai reverse proxy. Aplikasi dapat diakses memakai IP VPS terlebih dahulu; setelah domain tersedia, arahkan DNS ke VPS lalu aktifkan HTTPS.

> **Catatan masa dukungan:** Ubuntu 25.04 dan 25.10 adalah rilis interim, bukan LTS. Masa dukungan Ubuntu 25.10 berakhir pada Juli 2026. Untuk deployment production baru pada Oktober 2026, gunakan rilis Ubuntu LTS yang masih didukung bila memungkinkan. File service dan konfigurasi Nginx di direktori ini tetap dapat dipakai pada Ubuntu 25.x.

## Kebutuhan jaringan

- VPS dapat mengakses MySQL sesuai `DB_HOST` di `.env`.
- VPS dapat mengakses SMB share sesuai `SMB_SHARE` di `.env` melalui TCP port 445. Pertahankan alamat share yang sama saat menyalin `.env`; jangan menaruh URL/kredensial di file service atau konfigurasi Nginx.
- Form upload menerima sampai 6 dokumen, masing-masing maksimal 10 MiB. Konfigurasi Nginx mengizinkan total request 65 MiB agar batas proxy tidak lebih kecil daripada batas aplikasi.
- Buka port masuk 22, 80, dan 443 pada firewall/security group. Jangan membuka port aplikasi 3000 ke Internet.

## 1. Siapkan paket dan akun service

Pasang Node.js 18 atau lebih baru, npm, MySQL (jika database berjalan di VPS), Nginx, dan utilitas pemeriksaan jaringan:

```bash
sudo apt update
sudo apt install -y nodejs npm nginx mysql-server netcat-openbsd
node --version
npm --version
```

Buat akun tanpa login interaktif:

```bash
sudo useradd --system --home-dir /opt/case-management-system --create-home --shell /usr/sbin/nologin caseapp
```

Salin/clone source aplikasi ke `/opt/case-management-system`, lalu install dependency:

```bash
cd /opt/case-management-system
sudo npm install --omit=dev
```

Pastikan `app.js`, `package.json`, `database_schema.sql`, serta direktori `lib`, `views`, dan `public` ada di direktori tersebut. Jangan salin `node_modules` dari Windows; pasang dependency langsung di VPS.

## 2. Konfigurasi environment dan database

Buat `/opt/case-management-system/.env` dari `.env.example` dan isi nilai produksi:

```bash
sudo cp /opt/case-management-system/.env.example /opt/case-management-system/.env
sudo nano /opt/case-management-system/.env
```

Atur `NODE_ENV=production`, `PORT=3000`, kredensial database, dan `SESSION_SECRET` acak yang kuat (contoh pembuatannya: `openssl rand -base64 48`). Untuk penyimpanan dokumen, gunakan nilai `SMB_SHARE` yang sama dengan konfigurasi saat ini, beserta username/password yang diizinkan mengakses share. Jangan commit atau membagikan `.env`.

Jika MySQL berjalan di VPS, siapkan database dan import schema (ganti placeholder nama user/password dengan nilai di `.env`):

```bash
sudo mysql
```

```sql
CREATE DATABASE case_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'case_management'@'localhost' IDENTIFIED BY 'GANTI_DENGAN_PASSWORD_DATABASE';
GRANT ALL PRIVILEGES ON case_management.* TO 'case_management'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
cd /opt/case-management-system
sudo mysql case_management < database_schema.sql
```

Jika DB berada di host lain, buat database/user di host tersebut, sesuaikan `DB_HOST`/kredensial `.env`, dan izinkan koneksi hanya dari alamat VPS.

Amankan file dan direktori yang perlu ditulis aplikasi:

```bash
sudo chown -R caseapp:caseapp /opt/case-management-system
sudo chmod 600 /opt/case-management-system/.env
sudo install -d -o caseapp -g caseapp /opt/case-management-system/uploads/case-documents
```

Pastikan port SMB dapat dijangkau dari VPS (gunakan nama host/IP dari `SMB_SHARE`):

```bash
nc -vz <SMB_HOST_DARI_ENV> 445
```

Alamat `SMB_SHARE` adalah alamat share SMB, bukan URL HTTP. Nilai berupa `//host/share` atau `smb://host/share` didukung oleh worker; koneksi upload harus dapat keluar ke host tersebut pada TCP port 445. Pemeriksaan `nc` hanya memastikan port dapat dijangkau, bukan membuktikan login atau hak tulis; pastikan `SMB_USERNAME`, `SMB_PASSWORD`, dan bila diperlukan `SMB_DOMAIN` pada `.env` di VPS valid dan akun memiliki izin membuat folder/menulis file ke share.

## 3. Pasang service systemd

```bash
sudo install -m 644 /opt/case-management-system/deploy/ubuntu-25/case-management.service /etc/systemd/system/case-management.service
sudo systemctl daemon-reload
sudo systemctl enable --now case-management
sudo systemctl status case-management --no-pager
sudo journalctl -u case-management -n 100 --no-pager
```

Uji aplikasi dari VPS sebelum mengaktifkan Nginx:

```bash
curl -I http://127.0.0.1:3000/login
```

## 4. Pasang Nginx dan firewall

```bash
sudo install -m 644 /opt/case-management-system/deploy/ubuntu-25/nginx.conf /etc/nginx/sites-available/case-management
sudo ln -s /etc/nginx/sites-available/case-management /etc/nginx/sites-enabled/case-management
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Endpoint formulir membuat case (`POST /case/new`) dan upload dokumen pada case (`POST /case/:id/upload-document`) diteruskan oleh Nginx ke aplikasi di `127.0.0.1:3000`. Setelah perubahan konfigurasi Nginx, periksa `sudo nginx -t` dan reload Nginx agar batas request 65 MiB berlaku.

Buka `http://<IP_VPS>/login`. Konfigurasi awal melayani HTTP karena domain belum ditentukan. Ketika domain sudah diarahkan ke VPS, ubah `server_name _;` di konfigurasi Nginx menjadi domain yang dipakai, lalu validasi dan reload:

```bash
sudo nano /etc/nginx/sites-available/case-management
sudo nginx -t
sudo systemctl reload nginx
```

Setelah itu pasang TLS menggunakan Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <DOMAIN>
```

Setelah HTTPS aktif, pada `.env` set `TRUST_PROXY=1` dan `COOKIE_SECURE=true`, kemudian restart aplikasi:

```bash
sudo systemctl restart case-management
```

`TRUST_PROXY=1` hanya sesuai bila aplikasi menerima trafik melalui reverse proxy tepercaya (Nginx di VPS ini). Jangan aktifkan `COOKIE_SECURE=true` sebelum HTTPS aktif, karena browser tidak akan mengirim cookie session lewat HTTP.

## Operasional

- Log aplikasi: `sudo journalctl -u case-management -f`
- Restart: `sudo systemctl restart case-management`
- Status: `sudo systemctl status case-management --no-pager`
- Port aplikasi hanya diakses lokal melalui Nginx; UFW tidak membuka port 3000.

Catatan: aplikasi saat ini menggunakan session store bawaan Express di memori. Session akan hilang ketika service restart, dan konfigurasi ini ditujukan untuk satu instance aplikasi.
