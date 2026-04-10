require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        setTimeout(() => db.connect(), 3000);
    } else {
        console.log('MySQL Connected...');
    }
});

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
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
    let query = `
        SELECT c.*, u.username as pic_name, u.id as pic_id_check
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id`;
    
    // Logic: User hanya lihat case miliknya
    if (req.session.role === 'user') {
        query += " WHERE c.pic_id = " + db.escape(req.session.user_id);
    }

    query += " ORDER BY c.id DESC";

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
    
    let query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.type = ?`;
    
    // Logic: User hanya lihat case miliknya
    if (req.session.role === 'user') {
        query += " AND c.pic_id = " + db.escape(req.session.user_id);
    }

    query += " ORDER BY c.id DESC";

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
app.get('/case/new', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
    res.render('pages/case_form_new', { 
        caseItem: null, 
        caseTypes: ['Regular Case', 'On-Desk Case', 'Reliance Case'],
        user: req.session.user,
        role: req.session.role
    });
});

app.post('/case/new', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
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
app.get('/case/:id/edit', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
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

app.post('/case/:id/edit', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
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
app.post('/case/:id/delete', checkAuth, checkRole(['admin', 'spv']), (req, res) => {
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
        
        // Check access: user hanya bisa lihat case mereka
        if (req.session.role === 'user' && caseData.pic_id !== req.session.user_id) {
            return res.status(403).send('Unauthorized');
        }

        res.render('pages/case_detail_new', { 
            caseItem: caseData, 
            user: req.session.user,
            role: req.session.role,
            userId: req.session.user_id
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

// --- CSV IMPORT ROUTE ---

const storage = multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv') {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files allowed'));
        }
    }
});

app.get('/import-cases', checkAuth, checkRole(['admin']), (req, res) => {
    res.render('pages/import_cases_new', {
        user: req.session.user,
        role: req.session.role
    });
});

app.post('/import-cases', checkAuth, checkRole(['admin']), upload.single('file'), (req, res) => {
    const filePath = req.file.path;
    const results = [];
    let successCount = 0;
    let errorCount = 0;

    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
            results.push(data);
        })
        .on('end', () => {
            // Insert all data
            const sql = "INSERT INTO cases SET ?";
            
            results.forEach((row) => {
                db.query(sql, {
                    type: row.type,
                    title: row.title,
                    description: row.description || '',
                    priority: row.priority || 'Medium',
                    status: 'Unassigned'
                }, (err) => {
                    if (err) {
                        errorCount++;
                        console.error(err);
                    } else {
                        successCount++;
                    }
                });
            });

            // Clean up file
            fs.unlinkSync(filePath);
            
            res.render('pages/import_cases_new', { 
                message: `Import complete! Success: ${successCount}, Failed: ${errorCount}`,
                importResult: { total: results.length, success: successCount, failed: errorCount },
                user: req.session.user,
                role: req.session.role
            });
        })
        .on('error', (err) => {
            fs.unlinkSync(filePath);
            res.render('pages/import_cases_new', { 
                message: 'Error reading CSV file: ' + err.message,
                user: req.session.user,
                role: req.session.role
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
