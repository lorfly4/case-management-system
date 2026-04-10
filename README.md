# Case Management System Distribution

Sistem bagi-bagi case yang merata dengan fitur monitoring, distribusi, dan track progress case untuk 3 role (Admin, SPV, User).

## Fitur Utama

### 1. **Dashboard**
- Menampilkan 3 kategori case (Regular, On-Desk, Reliance) dengan jumlahnya
- Chart Top 5 PIC dengan case yang sedang ditangani (In Progress/Unassigned)
- Indikator case yang belum terassign

### 2. **Case Management**
- **All Cases View**: Menampilkan semua case (User hanya bisa lihat case mereka)
- **Category View**: Filter case berdasarkan tipe (Regular, On-Desk, Reliance)
- **Case Detail**: Lihat detail case, progress, dan activity log
- **CRUD Operations**: Buat, edit, delete case

### 3. **Case Distribution**
- **Assign PIC**: Admin/SPV bisa assign case ke PIC
- **Current Load Indicator**: Lihat jumlah active cases untuk setiap PIC saat memilih
- Format: "Username (Active Cases: 5)"
- SPV juga bisa menjadi PIC

### 4. **User Management** (Admin Only)
- CRUD Users (Create, Read, Update, Delete)
- Set role untuk setiap user (Admin, SPV, User)
- Enkripsi password menggunakan bcrypt

### 5. **CSV Import**
- Import case dari file CSV
- Format: case_number, type, title, description, priority
- Validasi dan error handling

### 6. **Activity Tracking**
- Track setiap perubahan case (assign, status update)
- Activity log di detail case

## Role & Permissions

| Feature | Admin | SPV | User |
|---------|-------|-----|------|
| Dashboard | ✅ | ✅ | ✅ |
| View All Cases | ✅ | ✅ | ❌ (hanya milik mereka) |
| Create Case | ✅ | ✅ | ❌ |
| Edit Case | ✅ | ✅ | ❌ |
| Delete Case | ✅ | ✅ | ❌ |
| Assign Case | ✅ | ✅ | ❌ |
| Update Own Case Status | ✅ | ✅ | ✅ (jika assigned ke mereka) |
| Manage Users | ✅ | ❌ | ❌ |
| Import CSV | ✅ | ❌ | ❌ |

## Installation & Setup

### 1. **Database Setup**
```bash
# Buka MySQL
mysql -u root -p

# Create database
CREATE DATABASE case_management;

# Import schema
source database_schema.sql;
```

### 2. **Install Dependencies**
```bash
npm install
```

### 3. **Environment Setup**
Edit file `.env`:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=case_management
SESSION_SECRET=Akugataumales1
PORT=3000
NODE_ENV=development
```

### 4. **Create Initial Admin User**
```bash
# Buka MySQL
mysql -u root

# Connect to database
USE case_management;

# Insert admin user (password: admin123)
INSERT INTO users (username, email, password, role) VALUES (
  'admin',
  'admin@example.com',
  '$2b$08$example_hashed_password',
  'admin'
);
```

Atau gunakan aplikasi untuk register dan ubah role-nya ke admin di database.

### 5. **Run Server**
```bash
npm run dev
```

Server akan berjalan di `http://localhost:3000`

## Project Structure

```
distribution/
├── app.js                    # Main application file
├── package.json             # Dependencies
├── .env                     # Environment variables
├── database_schema.sql      # Database schema
├── sample_cases.csv         # Sample CSV untuk testing
├── views/
│   ├── layouts/
│   │   ├── header.ejs       # Navigation & sidebar
│   │   └── footer.ejs       # Footer & scripts
│   └── pages/
│       ├── login.ejs        # Login page
│       ├── register.ejs     # Register page
│       ├── dashboard.ejs    # Dashboard
│       ├── all_cases.ejs    # All cases view
│       ├── cases_by_type.ejs # Cases filtered by type
│       ├── case_detail.ejs  # Case detail & activity
│       ├── case_form.ejs    # Create/Edit case
│       ├── users_list.ejs   # User management list
│       ├── user_form.ejs    # Create/Edit user
│       └── import_cases.ejs # CSV import
├── public/                  # Static files (CSS, JS)
├── uploads/                 # CSV uploads folder
└── routes/                  # (Optional) Modular routes
```

## Database Tables

### users
- `id`: Primary Key
- `username`: Unique username
- `password`: Hashed password (bcrypt)
- `email`: Unique email
- `role`: admin|spv|user
- `created_at`: Timestamp

### cases
- `id`: Primary Key
- `case_number`: Unique case identifier
- `type`: Regular Case|On-Desk Case|Reliance Case
- `title`: Case title
- `description`: Case description
- `status`: Unassigned|In Progress|On Hold|Closed
- `priority`: Low|Medium|High
- `pic_id`: Foreign key ke users (PIC)
- `created_at`, `updated_at`: Timestamps

### case_activities
- `id`: Primary Key
- `case_id`: Foreign key ke cases
- `activity_type`: assigned|status_changed|...
- `description`: Activity description
- `created_by`: User ID yang melakukan activity
- `created_at`: Timestamp

## API Endpoints

### Authentication
- `GET /login` - Login page
- `POST /login` - Login process
- `GET /register` - Register page
- `POST /register` - Register process
- `GET /logout` - Logout

### Dashboard
- `GET /dashboard` - Dashboard

### Cases
- `GET /all-cases` - All cases
- `GET /cases/:type` - Cases by type
- `GET /case/:id` - Case detail
- `GET /case/new` - Create case form
- `POST /case/new` - Create case
- `GET /case/:id/edit` - Edit case form
- `POST /case/:id/edit` - Update case
- `POST /case/:id/delete` - Delete case
- `POST /assign-case` - Assign case to PIC
- `POST /update-case-status` - Update case status

### Users (Admin only)
- `GET /users` - Users list
- `GET /user/new` - Create user form
- `POST /user/new` - Create user
- `GET /user/:id/edit` - Edit user form
- `POST /user/:id/edit` - Update user
- `POST /user/:id/delete` - Delete user

### CSV
- `GET /import-cases` - Import form
- `POST /import-cases` - Process import

### API
- `GET /api/users-with-load` - Get all users dengan current load (untuk dropdown)

## Usage Example

### 1. Register & Login
1. Go to `http://localhost:3000/register`
2. Create account dengan username/email/password
3. Login dengan credentials

### 2. Create Initial Data
**As Admin:**
1. Buat beberapa user dengan role SPV dan User di Users Management
2. Create cases manually atau import dari CSV

### 3. Distribute Cases
**As Admin/SPV:**
1. Go to All Cases atau kategori case
2. Klik tombol "Assign" pada case yang belum punya PIC
3. Pilih PIC dari dropdown (lihat current load mereka)
4. Case akan di-assign dan status berubah ke "In Progress"

### 4. Track Case
**As PIC (User yang assigned):**
1. Go to Dashboard atau All Cases
2. Lihat case yang assigned ke mereka
3. Click case detail untuk lihat activity
4. Update status (In Progress → On Hold → Closed)

### 5. Monitor Distribution
**As Admin:**
1. Go to Dashboard
2. Lihat chart Top 5 PIC dengan active cases mereka
3. Adjust distribution jika ada yang overload

## Troubleshooting

### Error: Connect Failed
- Check MySQL running
- Verify .env database credentials

### Port 3000 Already In Use
- Change PORT in .env
- Or kill process: `lsof -ti:3000 | xargs kill -9`

### CSV Import Failed
- Check CSV format (headers harus: case_number,type,title,description,priority)
- Verify tipe case (Regular Case, On-Desk Case, Reliance Case)
- Check case_number tidak duplikat

## Future Features

- [ ] Export cases to CSV/Excel
- [ ] Case comments & notes
- [ ] Email notifications
- [ ] Case SLA tracking
- [ ] Advanced reporting & analytics
- [ ] Bulk operations
- [ ] API documentation (Swagger)

## Support

Untuk pertanyaan atau issues, silakan buat issue di repository ini.

---

**Created**: 2026
**Version**: 1.0.0
