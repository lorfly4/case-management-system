# Requirement Tambahan — Case Management System (CMS)
### (Versi: Case Type diubah menjadi Klaim Hospital / Non Klaim Hospital)

> **Catatan perubahan dari versi awal:**
> Field **Case Type** yang semula berisi *Regular Case / On-Desk Case / Reliance Case* diganti menjadi dua pilihan:
> - **Klaim Hospital**
> - **Non Klaim Hospital**
>
> Perubahan ini langsung menentukan input biaya/manfaat mana yang ditampilkan pada form (poin 2).

---

## 1. Create New Case — Case Type

Form awal pembuatan case baru (`Case Form`) memiliki field wajib:

- **Case Type*** (dropdown), pilihan:
  - Klaim Hospital
  - Non Klaim Hospital

---

## 2. Input Dinamis Berdasarkan Case Type

### 2.1 Jika dipilih **Klaim Hospital**

Form menampilkan input biaya berikut:

- Kamar Rawat Inap
- Biaya Dokter
- Biaya Tindakan/Prosedur Medis
- Biaya Obat-obatan
- Biaya Laboratorium
- Biaya Radiologi (Rontgen, CT Scan, atau MRI)
- Biaya Aneka Perawatan (Alat Kesehatan, Biaya Administrasi, dan biaya lain yang diatur dalam polis)

> **Behavior:** Setelah seluruh field di atas terisi, sistem otomatis menampilkan:
> - **Total Biaya Dijaminkan**
> - **Klaim yang Diajukan**

### 2.2 Jika dipilih **Non Klaim Hospital**

Form menampilkan input:

- Uang Pertanggungan yang Diajukan (nominal dalam Rupiah)
- Manfaat Nominal Klaim
- Klaim yang Disetujui

---

## 3. Informasi Polis

Field yang perlu ditambahkan pada section **Informasi Polis**:

| Field | Keterangan |
|---|---|
| No. Polis | |
| Pemegang Polis | |
| Tertanggung | |
| Tanggal Issued Polis | Format tanggal (contoh: 01/10/2026) |
| Jenis Claim | Terisi otomatis dari Case Type (Klaim Hospital / Non Klaim Hospital) |
| UP (Uang Pertanggungan) | Dropdown/selector |
| Usia Polis | |
| Pekerjaan Tertanggung | |
| Alamat | Text area |

### Tambahan input di bagian Informasi Polis:

- Pembayar Polis
- Status Polis (pada saat klaim terjadi)
- Manfaat yang di Klaim
- Nilai Pertanggungan

---

## 4. Claim Assessment

Field existing:

| Field | Keterangan |
|---|---|
| Status Claim | Contoh default: `Unassigned` |
| Hasil Assessment | |
| Dasar Ketentuan | Text area |

### Tambahan input pada section Claim Assessment:

- No. Klaim
- Jenis Penyakit Kritis yang Terdiagnosa
- Tanggal Diagnosa Ditegakkan oleh Dokter
- Tanggal Rawat Inap
- **Jenis Klaim** (dropdown pilihan):
  - Klaim Rawat Inap
  - Klaim Perawatan 1 Hari
  - Klaim Meninggal Dunia
  - Klaim Penyakit Kritis
  - Credit Life
  - Claim Lainnya
- Tanggal Kejadian Klaim
- Tanggal dan Tempat Meninggal
- Status Hubungan dengan Pemegang Polis
- Data atau Dokumen Penerima Manfaat
- Dokumen Kematian
- Dokumen Identitas
- Dokumen Medis atau Laporan dari Rumah Sakit (jika diperlukan)
- Laporan Kepolisian (untuk kasus tertentu)

---

## 5. Dokumen dan Verifikasi

Section baru untuk kelengkapan proses klaim:

- Upload Dokumen
- Checklist Kelengkapan Dokumen
- Verifikasi Manfaat
- Verifikasi Polis
- Investigasi (bila diperlukan — disertai checklist)
- Keputusan Klaim
- Catatan dari Klaim Assessor

---

## Catatan & Risiko dari Perubahan Case Type

- Field "Jenis Klaim" tetap muncul di dua tempat dengan konteks berbeda:
  1. **Informasi Polis** — otomatis mengikuti Case Type (Klaim Hospital / Non Klaim Hospital), sifatnya kategori besar.
  2. **Claim Assessment** — dropdown manual yang lebih detail/granular (Rawat Inap, Penyakit Kritis, Meninggal Dunia, dll). Ini perlu dipastikan **konsisten/selaras** dengan Case Type di atasnya — misalnya "Klaim Meninggal Dunia" harus otomatis tergolong *Non Klaim Hospital*, sedangkan "Klaim Rawat Inap" harus tergolong *Klaim Hospital*.
- Jika sebelumnya *Regular Case / On-Desk Case / Reliance Case* dipakai di tempat lain pada sistem (misalnya untuk routing/assignment ke tim tertentu, SLA, atau aturan approval), penggantian field ini **berpotensi menghilangkan informasi tersebut**. Perlu dicek apakah ketiga istilah itu masih dipakai di bagian lain CMS sebelum field ini resmi diganti — jika masih dipakai, sebaiknya dipertimbangkan untuk ditambahkan sebagai field terpisah, bukan digantikan sepenuhnya.
