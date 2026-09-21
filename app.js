require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const { canCreateCase, canImportCases, canUploadCaseDocument } = require('./lib/case_permissions');

const app = express();

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads', 'case-documents'), { recursive: true });

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const ensureCaseDocumentsTable = () => {
    const query = `
        CREATE TABLE IF NOT EXISTS case_documents (
            id INT AUTO_INCREMENT PRIMARY KEY,
            case_id INT NOT NULL,
            filename VARCHAR(255) NOT NULL,
            original_name VARCHAR(255) NOT NULL,
            uploaded_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
            FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
        )
    `;

    return new Promise((resolve, reject) => {
        db.query(query, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
};

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        setTimeout(() => db.connect(), 3000);
    } else {
        console.log('MySQL Connected...');
        ensureCaseDocumentsTable()
            .then(() => console.log('Table case_documents ready'))
            .catch((migrationErr) => console.error('Failed to create case_documents table:', migrationErr.message));
    }
});

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Global Middleware untuk Check Authentication & Role
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.role = req.session.role || null;
    res.locals.userId = req.session.user_id || null;
    res.locals.currentPath = req.path;
    res.locals.hideChrome = false; // Default: show navbar and footer
    next();
});

// Middleware: Cek Authentication
const checkAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
};

// Middleware: Cek Role
const checkRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.session.role)) {
            return res.status(403).send('Unauthorized Access');
        }
        next();
    };
};

// --- AUTH ROUTES ---

/**
 * LOGIN PAGE
 */
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('pages/login_new');
});

/**
 * LOGIN POST
 */
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    const query = 'SELECT * FROM users WHERE username = ?';
    db.query(query, [username], async (err, results) => {
        if (err) throw err;
        
        if (results.length === 0) {
            return res.render('pages/login_new', { errorMessage: 'Username tidak ditemukan' });
        }

        const user = results[0];
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.render('pages/login_new', { errorMessage: 'Password salah' });
        }

        // Set session
        req.session.user = user.username;
        req.session.user_id = user.id;
        req.session.role = user.role;

        res.redirect('/dashboard');
    });
});

/**
 * REGISTER PAGE
 */
app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('pages/register_new');
});

/**
 * REGISTER POST
 */
app.post('/register', async (req, res) => {
    const { username, email, password, passwordConfirm } = req.body;

    if (!username || !email || !password || !passwordConfirm) {
        return res.render('pages/register_new', { message: 'Please provide all required fields' });
    }

    if (password !== passwordConfirm) {
        return res.render('pages/register_new', { message: 'Passwords do not match' });
    }

    const hashedPassword = await bcrypt.hash(password, 8);
    
    const query = 'INSERT INTO users SET ?';
    db.query(query, { username: username, email: email, password: hashedPassword, role: 'user' }, (err, result) => {
        if (err) {
            return res.render('pages/register_new', { message: 'Username or email already exists!' });
        }
        return res.render('pages/register_new', { message: 'User registered successfully!' });
    });
});

/**
 * LOGOUT
 */
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.send('Error');
        res.redirect('/login');
    });
});

// --- DASHBOARD ROUTE ---

/**
 * DASHBOARD
 * Menampilkan Summary Kategori & Chart Top 5 PIC
 */
app.get('/dashboard', checkAuth, (req, res) => {
    // Query 1: Count per Category
    const queryCategory = `
        SELECT type, COUNT(*) as count 
        FROM cases 
        GROUP BY type`;

    // Query 2: Top 5 PIC Load (Status In Progress)
    const queryTopPIC = `
        SELECT u.id, u.username, COUNT(c.id) as load_count 
        FROM users u 
        LEFT JOIN cases c ON u.id = c.pic_id AND c.status IN ('In Progress', 'Unassigned')
        WHERE u.role IN ('user', 'spv')
        GROUP BY u.id 
        ORDER BY load_count DESC 
        LIMIT 5`;

    // Query 3: Unassigned cases count
    const queryUnassigned = `SELECT COUNT(*) as count FROM cases WHERE status = 'Unassigned'`;

    db.query(queryCategory, (err, catResults) => {
        if (err) throw err;
        db.query(queryTopPIC, (err, picResults) => {
            if (err) throw err;
            db.query(queryUnassigned, (err, unassignedResults) => {
                if (err) throw err;
                res.render('pages/dashboard_new', {
                    categories: catResults,
                    topPIC: picResults,
                    unassigned: unassignedResults[0].count,
                    user: req.session.user,
                    role: req.session.role
                });
            });
        });
    });
});

// --- CASES ROUTES ---

/**
 * ALL CASES (Global View)
 */
app.get('/all-cases', checkAuth, (req, res) => {
    const query = `
        SELECT c.*, u.username as pic_name, u.id as pic_id_check
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        ORDER BY c.id DESC`;

    db.query(query, (err, results) => {
        if (err) throw err;
        res.render('pages/all_cases_new', { 
            cases: results,
            user: req.session.user,
            role: req.session.role
        });
    });
});

/**
 * CASES BY CATEGORY
 */
app.get('/cases/:type', checkAuth, (req, res) => {
    const { type } = req.params;
    
    const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.type = ?
        ORDER BY c.id DESC`;

    db.query(query, [type], (err, results) => {
        if (err) throw err;
        res.render('pages/cases_by_type_new', { 
            cases: results, 
            type: type,
            user: req.session.user,
            role: req.session.role
        });
    });
});

/**
 * CREATE NEW CASE (Admin & SPV) - HARUS SEBELUM /case/:id
 */
app.get('/case/new', checkAuth, (req, res) => {
    if (!canCreateCase(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    res.render('pages/case_form_new', { 
        caseItem: null, 
        caseTypes: ['Regular Case', 'On-Desk Case', 'Reliance Case'],
        user: req.session.user,
        role: req.session.role
    });
});

app.post('/case/new', checkAuth, (req, res) => {
    if (!canCreateCase(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    const { type, title, description, priority } = req.body;
    
    const sql = "INSERT INTO cases SET ?";
    db.query(sql, {
        type: type,
        title: title,
        description: description,
        priority: priority,
        status: 'Unassigned'
    }, (err, result) => {
        if (err) {
            return res.render('pages/case_form_new', { 
                message: 'Error creating case: ' + err.message, 
                caseItem: null, 
                caseTypes: ['Regular Case', 'On-Desk Case', 'Reliance Case'],
                user: req.session.user,
                role: req.session.role
            });
        }
        res.redirect('/all-cases');
    });
});

/**
 * EDIT CASE
 */
app.get('/case/:id/edit', checkAuth, (req, res) => {
    if (!canCreateCase(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    const query = 'SELECT * FROM cases WHERE id = ?';
    db.query(query, [req.params.id], (err, results) => {
        if (err) throw err;
        if (results.length === 0) return res.status(404).send('Case not found');
        res.render('pages/case_form_new', { 
            caseItem: results[0], 
            caseTypes: ['Regular Case', 'On-Desk Case', 'Reliance Case'],
            user: req.session.user,
            role: req.session.role
        });
    });
});

app.post('/case/:id/edit', checkAuth, (req, res) => {
    if (!canCreateCase(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    const { title, description, priority, status } = req.body;
    
    const sql = "UPDATE cases SET title = ?, description = ?, priority = ?, status = ? WHERE id = ?";
    db.query(sql, [title, description, priority, status, req.params.id], (err, result) => {
        if (err) throw err;
        res.redirect(`/case/${req.params.id}`);
    });
});

/**
 * DELETE CASE
 */
app.post('/case/:id/delete', checkAuth, (req, res) => {
    if (!['admin', 'spv'].includes(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    const sql = "DELETE FROM cases WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) throw err;
        res.redirect('/all-cases');
    });
});

/**
 * CASE DETAIL
 */
app.get('/case/:id', checkAuth, (req, res) => {
    const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.id = ?`;
    
    db.query(query, [req.params.id], (err, results) => {
        if (err) throw err;
        if (results.length === 0) return res.status(404).send('Case not found');
        
        const caseData = results[0];
        const documentQuery = 'SELECT * FROM case_documents WHERE case_id = ? ORDER BY created_at DESC';

        db.query(documentQuery, [req.params.id], (docErr, documentResults) => {
            if (docErr) {
                if (docErr.code === 'ER_NO_SUCH_TABLE') {
                    return res.render('pages/case_detail_new', {
                        caseItem: caseData,
                        documents: [],
                        user: req.session.user,
                        role: req.session.role,
                        userId: req.session.user_id
                    });
                }
                throw docErr;
            }

            res.render('pages/case_detail_new', { 
                caseItem: caseData, 
                documents: documentResults,
                user: req.session.user,
                role: req.session.role,
                userId: req.session.user_id
            });
        });
    });
});

/**
 * GET ALL USERS WITH CURRENT LOAD (untuk dropdown/modal PIC selection)
 */
app.get('/api/users-with-load', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
    const query = `
        SELECT u.id, u.username, COUNT(c.id) as load_count 
        FROM users u 
        LEFT JOIN cases c ON u.id = c.pic_id AND c.status IN ('In Progress', 'Unassigned')
        WHERE u.role IN ('user', 'spv')
        GROUP BY u.id 
        ORDER BY u.username ASC`;
    
    db.query(query, (err, results) => {
        if (err) return res.json({ error: err });
        res.json(results);
    });
});

/**
 * ASSIGN CASE TO PIC
 */
app.post('/assign-case', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
    const { case_id, pic_id } = req.body;
    
    if (!pic_id) {
        return res.json({ success: false, error: 'Please select a user to assign' });
    }
    
    const sql = "UPDATE cases SET pic_id = ?, status = 'In Progress' WHERE id = ?";
    db.query(sql, [pic_id, case_id], (err, result) => {
        if (err) return res.json({ success: false, error: err.message });
        if (result.affectedRows === 0) return res.json({ success: false, error: 'Case not found' });
        
        res.json({ success: true });
    });
});

/**
 * UPDATE CASE STATUS
 */
app.post('/update-case-status', checkAuth, (req, res) => {
    const { case_id, status, activity_description } = req.body;
    
    if (!status) {
        return res.json({ success: false, error: 'Please select a status' });
    }

    // Check if user is the assigned PIC or is admin/spv
    const checkQuery = 'SELECT pic_id FROM cases WHERE id = ?';
    db.query(checkQuery, [case_id], (err, results) => {
        if (err) {
            return res.json({ success: false, error: err.message });
        }
        if (results.length === 0) {
            return res.json({ success: false, error: 'Case not found' });
        }
        
        const caseData = results[0];
        if (req.session.role === 'user' && caseData.pic_id !== req.session.user_id) {
            return res.json({ success: false, error: 'Unauthorized - only assigned PIC can update this case' });
        }

        const sql = "UPDATE cases SET status = ? WHERE id = ?";
        db.query(sql, [status, case_id], (err, result) => {
            if (err) {
                return res.json({ success: false, error: err.message });
            }
            if (result.affectedRows === 0) {
                return res.json({ success: false, error: 'Case not found' });
            }
            
            res.json({ success: true });
        });
    });
});

// --- USER MANAGEMENT ROUTES (Admin Only) ---

/**
 * LIST ALL USERS
 */
app.get('/users', checkAuth, checkRole(['admin']), (req, res) => {
    const query = 'SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC';
    db.query(query, (err, results) => {
        if (err) throw err;
        res.render('pages/users_list_new', { 
            users: results,
            user: req.session.user,
            role: req.session.role
        });
    });
});

/**
 * CREATE NEW USER
 */
app.get('/user/new', checkAuth, checkRole(['admin']), (req, res) => {
    res.render('pages/user_form_new', { 
        user: null, 
        roles: ['admin', 'spv', 'user'],
        currentUser: req.session.user
    });
});

app.post('/user/new', checkAuth, checkRole(['admin']), async (req, res) => {
    const { username, email, password, role } = req.body;
    
    if (!username || !email || !password) {
        return res.render('pages/user_form_new', { 
            message: 'All fields required', 
            user: null, 
            roles: ['admin', 'spv', 'user'],
            currentUser: req.session.user
        });
    }

    const hashedPassword = await bcrypt.hash(password, 8);
    const sql = "INSERT INTO users SET ?";
    
    db.query(sql, {
        username: username,
        email: email,
        password: hashedPassword,
        role: role
    }, (err, result) => {
        if (err) {
            return res.render('pages/user_form_new', { 
                message: 'Username or email already exists!', 
                user: null, 
                roles: ['admin', 'spv', 'user'],
                currentUser: req.session.user
            });
        }
        res.redirect('/users');
    });
});

/**
 * EDIT USER
 */
app.get('/user/:id/edit', checkAuth, checkRole(['admin']), (req, res) => {
    const query = 'SELECT * FROM users WHERE id = ?';
    db.query(query, [req.params.id], (err, results) => {
        if (err) throw err;
        if (results.length === 0) return res.status(404).send('User not found');
        res.render('pages/user_form_new', { 
            user: results[0], 
            roles: ['admin', 'spv', 'user'],
            currentUser: req.session.user
        });
    });
});

app.post('/user/:id/edit', checkAuth, checkRole(['admin']), async (req, res) => {
    const { username, email, role, password } = req.body;
    
    let query, params;
    
    if (password) {
        const hashedPassword = await bcrypt.hash(password, 8);
        query = "UPDATE users SET username = ?, email = ?, role = ?, password = ? WHERE id = ?";
        params = [username, email, role, hashedPassword, req.params.id];
    } else {
        query = "UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?";
        params = [username, email, role, req.params.id];
    }
    
    db.query(query, params, (err, result) => {
        if (err) throw err;
        res.redirect('/users');
    });
});

/**
 * DELETE USER
 */
app.post('/user/:id/delete', checkAuth, checkRole(['admin']), (req, res) => {
    // First unassign all cases from this user
    const unassignQuery = "UPDATE cases SET pic_id = NULL WHERE pic_id = ?";
    db.query(unassignQuery, [req.params.id], (err) => {
        if (err) throw err;
        
        // Then delete user
        const deleteQuery = "DELETE FROM users WHERE id = ?";
        db.query(deleteQuery, [req.params.id], (err, result) => {
            if (err) throw err;
            res.redirect('/users');
        });
    });
});

// --- FILE UPLOADS ---

const caseDocumentStorage = multer.diskStorage({
    destination: path.join(__dirname, 'uploads', 'case-documents'),
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`);
    }
});

const caseDocumentUpload = multer({
    storage: caseDocumentStorage,
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
        if (isPdf) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files allowed for case document upload'));
        }
    }
});

const importStorage = multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`);
    }
});

const importUpload = multer({
    storage: importStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedTypes = ['.csv', '.xls', '.xlsx'];
        const mimeTypes = [
            'text/csv',
            'application/csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];

        if (allowedTypes.includes(ext) || mimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV, XLS, or XLSX files are allowed'));
        }
    }
});

const parseImportRows = (filePath) => {
    return new Promise((resolve, reject) => {
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.csv') {
            const rows = [];
            fs.createReadStream(filePath)
                .pipe(csv())
                .on('data', (row) => rows.push(row))
                .on('end', () => resolve(rows))
                .on('error', reject);
            return;
        }

        try {
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '', raw: false });
            resolve(rows);
        } catch (error) {
            reject(error);
        }
    });
};

// --- CSV / EXCEL IMPORT ROUTE ---

app.get('/import-cases', checkAuth, (req, res) => {
    if (!canImportCases(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    res.render('pages/import_cases_new', {
        user: req.session.user,
        role: req.session.role
    });
});

app.post('/import-cases', checkAuth, (req, res) => {
    if (!canImportCases(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    importUpload.single('file')(req, res, async (err) => {
        if (err) {
            return res.render('pages/import_cases_new', {
                message: 'Error: ' + err.message,
                user: req.session.user,
                role: req.session.role
            });
        }

        if (!req.file) {
            return res.render('pages/import_cases_new', {
                message: 'Please select a CSV or Excel file to import.',
                user: req.session.user,
                role: req.session.role
            });
        }

        const filePath = req.file.path;
        let rows = [];
        let successCount = 0;
        let errorCount = 0;

        try {
            rows = await parseImportRows(filePath);

            const sql = 'INSERT INTO cases (type, title, description, priority, status) VALUES (?, ?, ?, ?, ?)';

            for (const row of rows) {
                const type = (row.type || row.Type || '').toString().trim();
                const title = (row.title || row.Title || '').toString().trim();
                const description = (row.description || row.Description || '').toString().trim();
                const priority = (row.priority || row.Priority || 'Medium').toString().trim();
                const status = (row.status || row.Status || 'Unassigned').toString().trim();

                if (!type || !title) {
                    errorCount++;
                    continue;
                }

                const validType = ['Regular Case', 'On-Desk Case', 'Reliance Case'].includes(type);
                const validPriority = ['Low', 'Medium', 'High'].includes(priority);
                const validStatus = ['Unassigned', 'In Progress', 'On Hold', 'Closed'].includes(status);

                if (!validType || !validPriority || !validStatus) {
                    errorCount++;
                    continue;
                }

                const insertResult = await new Promise((resolve, reject) => {
                    db.query(sql, [type, title, description || '', priority, status], (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                });

                if (insertResult) {
                    successCount++;
                }
            }

            res.render('pages/import_cases_new', {
                message: `Import complete! Success: ${successCount}, Failed: ${errorCount}`,
                importResult: { total: rows.length, success: successCount, failed: errorCount },
                user: req.session.user,
                role: req.session.role
            });
        } catch (err) {
            res.render('pages/import_cases_new', {
                message: 'Error reading CSV/Excel file: ' + err.message,
                user: req.session.user,
                role: req.session.role
            });
        } finally {
            if (req.file && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
    });
});

app.post('/case/:id/upload-document', checkAuth, (req, res) => {
    if (!canUploadCaseDocument(req.session.role)) {
        return res.status(403).send('Unauthorized Access');
    }

    caseDocumentUpload.single('document')(req, res, (err) => {
        if (err) {
            return res.status(400).send('Error uploading PDF: ' + err.message);
        }

        if (!req.file) {
            return res.status(400).send('No PDF file uploaded');
        }

        const sql = 'INSERT INTO case_documents (case_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?)';
        db.query(sql, [req.params.id, req.file.filename, req.file.originalname, req.session.user_id], (uploadErr) => {
            if (uploadErr) {
                fs.unlinkSync(req.file.path);
                return res.status(500).send('Failed to save document: ' + uploadErr.message);
            }

            res.redirect(`/case/${req.params.id}`);
        });
    });
});

// --- ROOT ROUTE ---

app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.redirect('/login');
});

// --- ERROR HANDLING ---
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// --- PORT SETUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { db };
