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
const PDFDocument = require('pdfkit');

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // Batas maksimal 2MB
});

const { canCreateCase, canImportCases, canUploadCaseDocument } = require('./lib/case_permissions');
const { resolveCaseJsonData, saveJsonUploadToDisk } = require('./lib/case_json_utils');

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

const ensureCasesJsonColumn = () => {
    return new Promise((resolve, reject) => {
        db.query('SHOW COLUMNS FROM cases LIKE "json_data"', (err, results) => {
            if (err) return reject(err);
            if (results.length === 0) {
                db.query('ALTER TABLE cases ADD COLUMN json_data LONGTEXT AFTER description', (alterErr) => {
                    if (alterErr) return reject(alterErr);
                    resolve();
                });
                return;
            }
            resolve();
        });
    });
};

const ensureCasesJsonFilePathColumn = () => {
    return new Promise((resolve, reject) => {
        db.query('SHOW COLUMNS FROM cases LIKE "json_file_path"', (err, results) => {
            if (err) return reject(err);
            if (results.length === 0) {
                db.query('ALTER TABLE cases ADD COLUMN json_file_path VARCHAR(255) NULL AFTER json_data', (alterErr) => {
                    if (alterErr) return reject(alterErr);
                    resolve();
                });
                return;
            }
            resolve();
        });
    });
};

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        setTimeout(() => db.connect(), 3000);
    } else {
        console.log('MySQL Connected...');
        Promise.all([
            ensureCaseDocumentsTable(),
            ensureCasesJsonColumn(),
            ensureCasesJsonFilePathColumn()
        ])
            .then(() => console.log('Database schema ready'))
            .catch((migrationErr) => console.error('Failed to ensure database schema:', migrationErr.message));
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

// Global Middleware
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.role = req.session.role || null;
    res.locals.userId = req.session.user_id || null;
    res.locals.currentPath = req.path;
    res.locals.hideChrome = false;
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

// --- HELPER FUNCTIONS & PDF GENERATOR LOGIC ---

const safeJsonParse = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
};

const safeNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
};

const safeText = (value, fallback = '-') => {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
};

const formatCurrency = (value) => {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
    }).format(safeNumber(value, 0));
};

const readablePdfValue = (value, fallback = '-') => {
    if (value === null || value === undefined || value === '') return fallback;

    if (typeof value === 'object') {
        if (Array.isArray(value)) {
            if (value.length === 0) return fallback;
            return value.map((item) => readablePdfValue(item)).join(', ');
        }

        return Object.entries(value)
            .map(([key, item]) => `${key.replace(/_/g, ' ')}: ${readablePdfValue(item)}`)
            .join('; ');
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return fallback;
        return trimmed;
    }

    return String(value);
};

/**
 * Mengubah label verdict rule engine menjadi teks awam
 */
const verdictToText = (verdict) => {
    const map = {
        pass: 'Terpenuhi',
        fail: 'Tidak Terpenuhi',
        not_applicable: 'Tidak Berlaku'
    };
    if (!verdict) return 'Tidak Diketahui';
    return map[String(verdict).toLowerCase()] || String(verdict);
};

/**
 * Mengubah teks JSON hasil evaluasi rule (dasar_ketentuan) menjadi
 * narasi bahasa Indonesia yang mudah dipahami orang awam.
 * Jika value bukan JSON valid / bukan array, dikembalikan apa adanya.
 */
const formatDasarKetentuan = (value) => {
    if (!value) return '-';

    let rules = value;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) {
            return value; // bukan JSON, biarkan apa adanya
        }
        try {
            rules = JSON.parse(trimmed);
        } catch (error) {
            return value; // gagal parse, kembalikan teks asli
        }
    }

    if (!Array.isArray(rules)) {
        rules = [rules];
    }

    if (rules.length === 0) return '-';

    const lines = rules.map((rule, index) => {
        if (!rule || typeof rule !== 'object') return `${index + 1}. ${String(rule)}`;

        const description = rule.description || rule.rule_id || `Ketentuan ${index + 1}`;
        const verdictText = verdictToText(rule.verdict);
        const clauseRef = rule.source_clause && rule.source_clause.reference
            ? rule.source_clause.reference
            : null;

        let line = `${index + 1}. ${description} — ${verdictText}`;
        if (clauseRef) {
            line += ` (Rujukan: ${clauseRef})`;
        }

        const evidenceNotes = Array.isArray(rule.evidence)
            ? rule.evidence.filter((e) => e && e.note).map((e) => e.note)
            : [];
        if (evidenceNotes.length > 0) {
            line += `. Catatan: ${evidenceNotes.join('; ')}`;
        }

        return line;
    });

    return lines.join('\n');
};

/**
 * Normalisasi data untuk Klaim Jiwa / Claim Assessment
 */
const normalizeClaimAssessmentData = (caseData) => {
    const json = resolveCaseJsonData(caseData) || {};
    const polis = json.informasi_polis || json.polis || {};
    const klaim = json.informasi_klaim || json.klaim || {};
    const assesment = json.claim_assesment || json.assesment || {};

    return {
        informasi_polis: [
            { label: 'No. Polis', value: readablePdfValue(polis.no_polis || caseData.no_polis || caseData.policy_id) },
            { label: 'Pemegang Polis', value: readablePdfValue(polis.pemegang_polis || caseData.pemegang_polis || caseData.policy_holder) },
            { label: 'Tertanggung', value: readablePdfValue(polis.tertanggung || caseData.tertanggung || caseData.member_name || caseData.pic_name) },
            { label: 'Tanggal Issued Polis', value: readablePdfValue(polis.tanggal_issued_polis || caseData.tanggal_issued_polis || caseData.policy_issued_date) },
            { label: 'Jenis Claim', value: readablePdfValue(polis.jenis_claim || caseData.jenis_claim || caseData.type) },
            { label: 'UP', value: readablePdfValue((polis.up || caseData.up || caseData.amount) ? (polis.up ? formatCurrency(polis.up) : formatCurrency(caseData.up || caseData.amount)) : '-') },
            { label: 'Usia Polis', value: readablePdfValue(polis.usia_polis || caseData.usia_polis) },
            { label: 'Pekerjaan Tertanggung', value: readablePdfValue(polis.pekerjaan_tertanggung || caseData.pekerjaan_tertanggung) },
            { label: 'Alamat', value: readablePdfValue(polis.alamat || caseData.alamat || caseData.address) }
        ],
        informasi_klaim: [
            { label: 'Tanggal Meninggal', value: readablePdfValue(klaim.tanggal_meninggal || caseData.tanggal_meninggal) },
            { label: 'Penyebab Meninggal', value: readablePdfValue(klaim.penyebab_meninggal || caseData.penyebab_meninggal) },
            { label: 'Tempat Meninggal', value: readablePdfValue(klaim.tempat_meninggal || caseData.tempat_meninggal) },
            { label: 'Pengaju Klaim', value: readablePdfValue(klaim.pengaju_klaim || caseData.pengaju_klaim) },
            { label: 'Kronologi Singkat', value: readablePdfValue(klaim.kronologi_singkat || caseData.kronologi_singkat || caseData.description) }
        ],
        claim_assesment: [
            { label: 'Status Claim', value: readablePdfValue(assesment.status_claim || caseData.status_claim || caseData.status) },
            { label: 'Hasil Assesment', value: readablePdfValue(assesment.hasil_assesment || caseData.hasil_assesment) },
            { label: 'Dasar Ketentuan', value: readablePdfValue(formatDasarKetentuan(assesment.dasar_ketentuan || caseData.dasar_ketentuan)) }
        ]
    };
};

/**
 * Penggambar Tabel 2-Kolom Sesuai Format PDF LPS
 */
const drawTableSection = (doc, sectionTitle, dataRows, options = {}) => {
    const startX = options.startX || 40;
    const col1Width = options.col1Width || 160;
    const col2Width = options.col2Width || 355;
    const totalWidth = col1Width + col2Width;
    const headerHeight = 22;
    const padding = 6;

    if (doc.y + 60 > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
    }

    doc.fillColor('#0F2A4A')
       .font('Helvetica-Bold')
       .fontSize(11)
       .text(sectionTitle, startX, doc.y);
    doc.moveDown(0.3);

    let currentY = doc.y;
    doc.fillColor('#1F3864')
       .rect(startX, currentY, totalWidth, headerHeight)
       .fill();

    doc.fillColor('#FFFFFF')
       .font('Helvetica-Bold')
       .fontSize(9);
    
    doc.text('Keterangan', startX + padding, currentY + 6, { width: col1Width - (padding * 2) });
    doc.text('Informasi', startX + col1Width + padding, currentY + 6, { width: col2Width - (padding * 2) });

    currentY += headerHeight;

    dataRows.forEach((row, index) => {
        const label = safeText(row.label, '-');
        const value = safeText(row.value, '-');

        doc.font('Helvetica-Bold').fontSize(8.5);
        const h1 = doc.heightOfString(label, { width: col1Width - (padding * 2) });
        doc.font('Helvetica').fontSize(8.5);
        const h2 = doc.heightOfString(value, { width: col2Width - (padding * 2) });

        const rowHeight = Math.max(h1, h2) + (padding * 2);

        if (currentY + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
            doc.addPage();
            currentY = doc.y + 10;
        }

        const bgColor = index % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        doc.fillColor(bgColor)
           .rect(startX, currentY, totalWidth, rowHeight)
           .fill();

        doc.strokeColor('#D1D5DB').lineWidth(0.5)
           .rect(startX, currentY, totalWidth, rowHeight).stroke();
        
        doc.moveTo(startX + col1Width, currentY)
           .lineTo(startX + col1Width, currentY + rowHeight)
           .stroke();

        doc.fillColor('#1E293B')
           .font('Helvetica-Bold')
           .fontSize(8.5)
           .text(label, startX + padding, currentY + padding, {
               width: col1Width - (padding * 2),
               align: 'left'
           });

        doc.fillColor('#334155')
           .font('Helvetica')
           .fontSize(8.5)
           .text(value, startX + col1Width + padding, currentY + padding, {
               width: col2Width - (padding * 2),
               align: 'left'
           });

        currentY += rowHeight;
    });

    doc.y = currentY + 14;
};

/**
 * Mengubah nama field mentah (snake_case) menjadi label yang manusiawi
 */
const humanizeKey = (key) => {
    return String(key)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
};

/**
 * Mendeteksi apakah sebuah objek adalah hasil evaluasi rule/ketentuan
 * (punya field verdict + description/rule_id), agar bisa diformat
 * jadi narasi khusus, bukan sekadar key-value mentah.
 */
const isRuleLikeObject = (obj) => {
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj) &&
        Object.prototype.hasOwnProperty.call(obj, 'verdict') &&
        (Object.prototype.hasOwnProperty.call(obj, 'description') || Object.prototype.hasOwnProperty.call(obj, 'rule_id')));
};

/**
 * Format satu item hasil evaluasi rule menjadi satu kalimat mudah dipahami
 */
const formatRuleItem = (rule, index) => {
    const description = rule.description || rule.rule_id || `Ketentuan ${index + 1}`;
    const verdictText = verdictToText(rule.verdict);
    const clauseRef = rule.source_clause && rule.source_clause.reference
        ? rule.source_clause.reference
        : null;

    let line = `${index + 1}. ${description} — ${verdictText}`;
    if (clauseRef) {
        line += ` (Rujukan: ${clauseRef})`;
    }

    const evidenceNotes = Array.isArray(rule.evidence)
        ? rule.evidence.filter((e) => e && e.note).map((e) => e.note)
        : [];
    if (evidenceNotes.length > 0) {
        line += `. Catatan: ${evidenceNotes.join('; ')}`;
    }

    return line;
};

/**
 * Mengubah objek JSON apa pun menjadi kalimat "Label: nilai, Label: nilai"
 * yang mudah dibaca, tanpa pernah menampilkan JSON mentah.
 */
const humanizeObject = (obj) => {
    return Object.keys(obj)
        .map((k) => {
            let val = obj[k];
            if (String(k).toLowerCase() === 'verdict') {
                val = verdictToText(val);
            }
            return `${humanizeKey(k)}: ${humanizeValue(val)}`;
        })
        .join(', ');
};

/**
 * Mengubah nilai apa pun (primitif, objek, atau array) menjadi teks
 * yang mudah dipahami orang awam. Tidak pernah mengembalikan JSON mentah.
 */
const humanizeValue = (value) => {
    if (value === null || value === undefined || value === '') return '-';

    if (Array.isArray(value)) {
        if (value.length === 0) return '-';

        if (value.every((v) => isRuleLikeObject(v))) {
            return value.map((v, idx) => formatRuleItem(v, idx)).join('\n');
        }

        if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
            return value.map((item, idx) => `${idx + 1}. ${humanizeObject(item)}`).join('\n');
        }

        return value.map((v) => humanizeValue(v)).join(', ');
    }

    if (typeof value === 'object') {
        return humanizeObject(value);
    }

    return String(value);
};

/**
 * Helper untuk merender tabel Key-Value dari objek JSON secara dinamis
 */
const drawJsonAsTable = (doc, dataObject, startX = 40) => {
    const col1Width = 160;
    const col2Width = 355;
    const totalWidth = col1Width + col2Width;
    const padding = 6;

    const renderRows = (obj, prefix = '') => {
        Object.keys(obj).forEach((key) => {
            const value = obj[key];
            const formattedKey = (prefix ? `${prefix} -> ` : '') + key.replace(/_/g, ' ').toUpperCase();

            // Jika nilainya adalah objek/array bertingkat
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                renderRows(value, formattedKey);
                return;
            }

            const displayValue = humanizeValue(value);

            // Pengecekan batas halaman
            doc.font('Helvetica-Bold').fontSize(8.5);
            const h1 = doc.heightOfString(formattedKey, { width: col1Width - (padding * 2) });
            doc.font('Helvetica').fontSize(8.5);
            const h2 = doc.heightOfString(displayValue, { width: col2Width - (padding * 2) });

            const rowHeight = Math.max(h1, h2) + (padding * 2);

            if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
                doc.addPage();
            }

            const currentY = doc.y;

            // Zebra Striping Background
            doc.fillColor('#F8FAFC')
               .rect(startX, currentY, totalWidth, rowHeight)
               .fill();

            // Border Box
            doc.strokeColor('#CBD5E1').lineWidth(0.5)
               .rect(startX, currentY, totalWidth, rowHeight).stroke();
            
            // Pemisah Kolom
            doc.moveTo(startX + col1Width, currentY)
               .lineTo(startX + col1Width, currentY + rowHeight)
               .stroke();

            // Kolom Kunci (Key)
            doc.fillColor('#1E293B')
               .font('Helvetica-Bold')
               .fontSize(8.5)
               .text(formattedKey, startX + padding, currentY + padding, {
                   width: col1Width - (padding * 2),
                   align: 'left'
               });

            // Kolom Nilai (Value)
            doc.fillColor('#334155')
               .font('Helvetica')
               .fontSize(8.5)
               .text(displayValue, startX + col1Width + padding, currentY + padding, {
                   width: col2Width - (padding * 2),
                   align: 'left'
               });

            doc.y = currentY + rowHeight;
        });
    };

    renderRows(dataObject);
};

// --- AUTH ROUTES ---

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('pages/login_new');
});

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

        req.session.user = user.username;
        req.session.user_id = user.id;
        req.session.role = user.role;

        res.redirect('/dashboard');
    });
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('pages/register_new');
});

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

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.send('Error');
        res.redirect('/login');
    });
});

// --- DASHBOARD ROUTE ---

app.get('/dashboard', checkAuth, (req, res) => {
    const queryCategory = `
        SELECT type, COUNT(*) as count 
        FROM cases 
        GROUP BY type`;

    const queryTopPIC = `
        SELECT u.id, u.username, COUNT(c.id) as load_count 
        FROM users u 
        LEFT JOIN cases c ON u.id = c.pic_id AND c.status IN ('In Progress', 'Unassigned')
        WHERE u.role IN ('user', 'spv')
        GROUP BY u.id 
        ORDER BY load_count DESC 
        LIMIT 5`;

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

app.post('/case/:id/upload-json', checkAuth, upload.single('json_file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('Silakan pilih file JSON terlebih dahulu.');
    }

    try {
        const parsedJson = JSON.parse(req.file.buffer.toString('utf-8'));
        const jsonString = JSON.stringify(parsedJson);
        const jsonFilePath = saveJsonUploadToDisk(req.file, req.params.id);

        const query = 'UPDATE cases SET json_data = ?, json_file_path = ? WHERE id = ?';
        db.query(query, [jsonString, jsonFilePath, req.params.id], (err, result) => {
            if (err) return res.status(500).send('Database error: ' + err.message);
            res.redirect(`/case/${req.params.id}`);
        });
    } catch (err) {
        return res.status(400).send('File yang diunggah bukan format JSON yang valid.');
    }
});

/**
 * GENERATE CASE PDF REPORT (Tabel JSON Rapi & Dynamic Footer)
 */
app.get('/case/:id/pdf', checkAuth, (req, res) => {
    const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.id = ?`;

    db.query(query, [req.params.id], (err, results) => {
        if (err) return res.status(500).send('Database error: ' + err.message);
        if (results.length === 0) return res.status(404).send('Case not found');

        const caseData = results[0];
        const reportData = normalizeClaimAssessmentData(caseData);

        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Claim_Assessment_Case_${caseData.id}.pdf`);
        doc.pipe(res);

        const logoPath = path.join(__dirname, 'uploads', 'logo.png');

        // ================= HALAMAN 1: CLAIM ASSESSMENT =================
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 425, 25, { fit: [130, 45], align: 'right' });
        }

        // Header Title
        doc.fillColor('#800000') // Maroon
           .font('Helvetica-Bold')
           .fontSize(16)
           .text('CLAIM ASSESMENT', 40, 32);

        doc.y = 70;

        // Tabel 1: Informasi Polis
        drawTableSection(doc, 'Informasi Polis', reportData.informasi_polis);

        // Tabel 2: Informasi Klaim
        drawTableSection(doc, 'Informasi Klaim', reportData.informasi_klaim);

        // Tabel 3: Claim Assesment
        drawTableSection(doc, 'Claim Assesment', reportData.claim_assesment);


        // ================= HALAMAN 2: TABEL DATA JSON =================
        if (caseData.json_data) {
            doc.addPage(); // Pindah ke halaman berikutnya

            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 425, 25, { fit: [130, 45], align: 'right' });
            }

            doc.fillColor('#800000')
               .font('Helvetica-Bold')
               .fontSize(14)
               .text('LAMPIRAN DATA DETAIL (JSON DATA)', 40, 32);

            doc.y = 70;

            try {
                const parsedObj = resolveCaseJsonData(caseData);
                if (Object.keys(parsedObj).length > 0) {
                    drawJsonAsTable(doc, parsedObj, 40);
                } else {
                    doc.fillColor('#DC2626')
                       .font('Helvetica')
                       .fontSize(9)
                       .text('Data JSON tidak dapat diurai ke dalam bentuk tabel.', 40, doc.y);
                }
            } catch (e) {
                // Fallback jika JSON tidak valid
                doc.fillColor('#DC2626')
                   .font('Helvetica')
                   .fontSize(9)
                   .text('Data JSON tidak dapat diurai ke dalam bentuk tabel.', 40, doc.y);
            }
        }

        // ================= DYNAMIC FOOTER UTK SEMUA HALAMAN =================
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            
            // Garis Tipis Footer
            doc.strokeColor('#E2E8F0')
               .lineWidth(0.5)
               .moveTo(40, doc.page.height - 45)
               .lineTo(doc.page.width - 40, doc.page.height - 45)
               .stroke();

            // Teks Footer di Margin Bawah
            doc.fillColor('#1F3864')
               .font('Helvetica-BoldOblique')
               .fontSize(9)
               .text('We Deliver Valuable Truth', 40, doc.page.height - 35, { align: 'left' });

            doc.fillColor('#64748B')
               .font('Helvetica')
               .fontSize(8)
               .text(`Halaman ${i + 1} dari ${range.count}`, 40, doc.page.height - 35, { align: 'right' });
        }

        doc.end();
    });
});

/**
 * ALL CASES
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
 * CREATE NEW CASE
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

    const {
        type,
        title,
        description,
        priority,
        no_polis,
        pemegang_polis,
        tertanggung,
        tanggal_issued_polis,
        jenis_claim,
        up,
        usia_polis,
        pekerjaan_tertanggung,
        alamat,
        tanggal_meninggal,
        penyebab_meninggal,
        tempat_meninggal,
        pengaju_klaim,
        kronologi_singkat,
        status_claim,
        hasil_assesment,
        dasar_ketentuan
    } = req.body;
    
    const sql = "INSERT INTO cases SET ?";
    db.query(sql, {
        type: type,
        title: title,
        description: description,
        priority: priority,
        no_polis: no_polis || null,
        pemegang_polis: pemegang_polis || null,
        tertanggung: tertanggung || null,
        tanggal_issued_polis: tanggal_issued_polis || null,
        jenis_claim: jenis_claim || null,
        up: up || null,
        usia_polis: usia_polis || null,
        pekerjaan_tertanggung: pekerjaan_tertanggung || null,
        alamat: alamat || null,
        tanggal_meninggal: tanggal_meninggal || null,
        penyebab_meninggal: penyebab_meninggal || null,
        tempat_meninggal: tempat_meninggal || null,
        pengaju_klaim: pengaju_klaim || null,
        kronologi_singkat: kronologi_singkat || null,
        status_claim: status_claim || 'Unassigned',
        hasil_assesment: hasil_assesment || null,
        dasar_ketentuan: dasar_ketentuan || null,
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

    const {
        title,
        description,
        priority,
        status,
        no_polis,
        pemegang_polis,
        tertanggung,
        tanggal_issued_polis,
        jenis_claim,
        up,
        usia_polis,
        pekerjaan_tertanggung,
        alamat,
        tanggal_meninggal,
        penyebab_meninggal,
        tempat_meninggal,
        pengaju_klaim,
        kronologi_singkat,
        status_claim,
        hasil_assesment,
        dasar_ketentuan
    } = req.body;
    
    const sql = `UPDATE cases SET title = ?, description = ?, priority = ?, status = ?,
        no_polis = ?, pemegang_polis = ?, tertanggung = ?, tanggal_issued_polis = ?, jenis_claim = ?, up = ?,
        usia_polis = ?, pekerjaan_tertanggung = ?, alamat = ?, tanggal_meninggal = ?, penyebab_meninggal = ?,
        tempat_meninggal = ?, pengaju_klaim = ?, kronologi_singkat = ?, status_claim = ?, hasil_assesment = ?,
        dasar_ketentuan = ? WHERE id = ?`;
    db.query(sql, [
        title,
        description,
        priority,
        status,
        no_polis || null,
        pemegang_polis || null,
        tertanggung || null,
        tanggal_issued_polis || null,
        jenis_claim || null,
        up || null,
        usia_polis || null,
        pekerjaan_tertanggung || null,
        alamat || null,
        tanggal_meninggal || null,
        penyebab_meninggal || null,
        tempat_meninggal || null,
        pengaju_klaim || null,
        kronologi_singkat || null,
        status_claim || status || null,
        hasil_assesment || null,
        dasar_ketentuan || null,
        req.params.id
    ], (err, result) => {
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
 * GET ALL USERS WITH CURRENT LOAD
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
    const { case_id, status } = req.body;
    
    if (!status) {
        return res.json({ success: false, error: 'Please select a status' });
    }

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

// --- USER MANAGEMENT ROUTES ---

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

app.post('/user/:id/delete', checkAuth, checkRole(['admin']), (req, res) => {
    const unassignQuery = "UPDATE cases SET pic_id = NULL WHERE pic_id = ?";
    db.query(unassignQuery, [req.params.id], (err) => {
        if (err) throw err;
        
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