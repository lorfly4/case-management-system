# 🚀 QUICK START GUIDE

## Step 1: Setup Database

### Open MySQL
```bash
mysql -u root -p
```

### Create Database & Import Schema
```sql
CREATE DATABASE case_management;
USE case_management;
source database_schema.sql;

-- (Optional) Create initial admin user
INSERT INTO users (username, email, password, role) VALUES (
  'admin',
  'admin@example.com',
  '$2b$08$LCY0MHu7B3.P4rT9N.D7.eVBhSt5HqENuJhFnGHjCQj0gXZK8iVb2',  -- password: admin123 (pre-hashed)
  'admin'
);
```

## Step 2: Check Dependencies
```bash
npm install
```

## Step 3: Configure Environment
Edit `.env` file:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=case_management
SESSION_SECRET=Akugataumales1
PORT=3000
NODE_ENV=development
```

## Step 4: Run Server
```bash
npm run dev
```

Server akan berjalan di: **http://localhost:3000**

## Step 5: First Login

### Option A: Register new account
1. Go to http://localhost:3000/register
2. Create account (akan dapat role 'user')
3. Login dengan credentials

### Option B: Use admin (jika sudah inject di database)
1. Go to http://localhost:3000/login
2. Username: `admin`
3. Password: `admin123`

## Step 6: Create Test Data

**As Admin:**
1. Go to **Users Management** (Users menu)
2. Create 2-3 SPV/User dengan click "Add New User"
   - Role: spv atau user
   
3. Go to **Create New Case** (atau Import Cases)
4. Create beberapa case atau import dari `sample_cases.csv`

## Step 7: Test Distribution

**As Admin/SPV:**
1. Go to **All Cases**
2. Klik tombol "Assign" pada unassigned case
3. Lihat dropdown dengan format: "Username (Current Load: X)"
4. Assign ke user pilihan

**As User (PIC):**
1. Login dengan user yang di-assign case
2. Go to **All Cases** - hanya lihat case milik mereka
3. Click case untuk lihat detail
4. Update status (In Progress → On Hold → Closed)

## Step 8: Monitor Dashboard

**Go to Dashboard:**
- Lihat 3 kategori case dan jumlahnya
- Klik kategori untuk filter by type
- Lihat chart Top 5 PIC dengan active cases

---

## 📋 Sample CSV Format

File: `sample_cases.csv`

```
case_number,type,title,description,priority
CS-001,Regular Case,Customer complaint,Customer reported issue,High
CS-002,On-Desk Case,Document review,Need approval,Medium
CS-003,Reliance Case,System maintenance,Regular check,Low
```

**Import steps:**
1. Go to **Import Cases (CSV)**
2. Upload CSV file
3. System akan process dan notifikasi success/failed count

---

## ⚙️ Default Ports & URLs

- **App URL**: http://localhost:3000
- **Login**: http://localhost:3000/login
- **Register**: http://localhost:3000/register
- **Dashboard**: http://localhost:3000/dashboard

---

## 🛠️ Troubleshooting

### Error: "MySQL Connected... failed"
- ✅ Check MySQL running
- ✅ Check .env credentials
- ✅ Check database `case_management` exists

### Error: "Port 3000 already in use"
- Change PORT in .env
- Or kill process: `lsof -ti:3000 | xargs kill -9` (Mac/Linux)

### Can't upload CSV
- Verify file is `.csv` format
- Check headers: `case_number,type,title,description,priority`
- Ensure case_number tidak duplikat

### User can't see cases
- Check if user is assigned as PIC (`pic_id` not null)
- Admin/SPV lihat semua, User cuma lihat punya mereka

---

## 📚 Key Routes

| Path | Description |
|------|-------------|
| `/login` | Login page |
| `/register` | Register page |
| `/dashboard` | Main dashboard |
| `/all-cases` | All/filtered cases |
| `/case/new` | Create case |
| `/users` | User management (Admin only) |
| `/import-cases` | CSV import (Admin only) |

---

## 🎯 Next Steps

1. ✅ Database setup
2. ✅ Server running
3. ✅ Create users
4. ✅ Create/import cases
5. ✅ Test distribution
6. ✅ Monitor dashboard

**Happy case managing! 🎉**
