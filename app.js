require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const session = require("express-session");
const path = require("path");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const multer = require("multer");
const csv = require("csv-parser");
const xlsx = require("xlsx");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // Batas maksimal 2MB
});

const {
  canCreateCase,
  canImportCases,
  canUploadCaseDocument,
} = require("./lib/case_permissions");
const {
  resolveCaseJsonData,
  saveJsonUploadToDisk,
} = require("./lib/case_json_utils");

const app = express();

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "uploads", "case-documents"), {
  recursive: true,
});

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
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
        db.query(
          "ALTER TABLE cases ADD COLUMN json_data LONGTEXT AFTER description",
          (alterErr) => {
            if (alterErr) return reject(alterErr);
            resolve();
          },
        );
        return;
      }
      resolve();
    });
  });
};

const ensureCasesJsonFilePathColumn = () => {
  return new Promise((resolve, reject) => {
    db.query(
      'SHOW COLUMNS FROM cases LIKE "json_file_path"',
      (err, results) => {
        if (err) return reject(err);
        if (results.length === 0) {
          db.query(
            "ALTER TABLE cases ADD COLUMN json_file_path VARCHAR(255) NULL AFTER json_data",
            (alterErr) => {
              if (alterErr) return reject(alterErr);
              resolve();
            },
          );
          return;
        }
        resolve();
      },
    );
  });
};

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    setTimeout(() => db.connect(), 3000);
  } else {
    console.log("MySQL Connected...");
    Promise.all([
      ensureCaseDocumentsTable(),
      ensureCasesJsonColumn(),
      ensureCasesJsonFilePathColumn(),
    ])
      .then(() => console.log("Database schema ready"))
      .catch((migrationErr) =>
        console.error(
          "Failed to ensure database schema:",
          migrationErr.message,
        ),
      );
  }
});

// --- MIDDLEWARE ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  }),
);

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
    return res.redirect("/login");
  }
  next();
};

// Middleware: Cek Role
const checkRole = (roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.session.role)) {
      return res.status(403).send("Unauthorized Access");
    }
    next();
  };
};

// --- HELPER FUNCTIONS & PDF GENERATOR LOGIC ---

const safeJsonParse = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

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

const safeText = (value, fallback = "-") => {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
};

const formatCurrency = (value) => {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(safeNumber(value, 0));
};

/**
 * Mengubah label verdict rule engine menjadi teks awam
 */
const verdictToText = (verdict) => {
  const map = {
    pass: "Terpenuhi",
    fail: "Tidak Terpenuhi",
    not_applicable: "Tidak Berlaku",
  };
  if (!verdict) return "Tidak Diketahui";
  return map[String(verdict).toLowerCase()] || String(verdict);
};

/**
 * Mengubah teks JSON hasil evaluasi rule (dasar_ketentuan) menjadi
 * narasi bahasa Indonesia yang mudah dipahami orang awam.
 * Jika value bukan JSON valid / bukan array, dikembalikan apa adanya.
 */
const formatDasarKetentuan = (value) => {
  if (!value) return "-";

  let rules = value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) {
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

  if (rules.length === 0) return "-";

  const lines = rules.map((rule, index) => {
    if (!rule || typeof rule !== "object")
      return `${index + 1}. ${String(rule)}`;

    const description =
      rule.description || rule.rule_id || `Ketentuan ${index + 1}`;
    const verdictText = verdictToText(rule.verdict);
    const clauseRef =
      rule.source_clause && rule.source_clause.reference
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
      line += `. Catatan: ${evidenceNotes.join("; ")}`;
    }

    return line;
  });

  return lines.join("\n");
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
      {
        label: "No. Polis",
        value: polis.no_polis || caseData.policy_id || "-",
      },
      {
        label: "Pemegang Polis",
        value: polis.pemegang_polis || caseData.policy_holder || "-",
      },
      {
        label: "Tertanggung",
        value:
          polis.tertanggung || caseData.member_name || caseData.pic_name || "-",
      },
      {
        label: "Tanggal Issued Polis",
        value: polis.tanggal_issued_polis || caseData.policy_issued_date || "-",
      },
      {
        label: "Jenis Claim",
        value: polis.jenis_claim || caseData.type || "-",
      },
      {
        label: "UP",
        value: polis.up
          ? formatCurrency(polis.up)
          : caseData.amount
            ? formatCurrency(caseData.amount)
            : "-",
      },
      { label: "Usia Polis", value: polis.usia_polis || "-" },
      {
        label: "Pekerjaan Tertanggung",
        value: polis.pekerjaan_tertanggung || "-",
      },
      { label: "Alamat", value: polis.alamat || caseData.address || "-" },
    ],
    informasi_klaim: [
      { label: "Tanggal Meninggal", value: klaim.tanggal_meninggal || "-" },
      { label: "Penyebab Meninggal", value: klaim.penyebab_meninggal || "-" },
      { label: "Tempat Meninggal", value: klaim.tempat_meninggal || "-" },
      { label: "Pengaju Klaim", value: klaim.pengaju_klaim || "-" },
      {
        label: "Kronologi Singkat",
        value: klaim.kronologi_singkat || caseData.description || "-",
      },
    ],
    claim_assesment: [
      {
        label: "Status Claim",
        value: assesment.status_claim || caseData.status || "-",
      },
      { label: "Hasil Assesment", value: assesment.hasil_assesment || "-" },
      {
        label: "Dasar Ketentuan",
        value: formatDasarKetentuan(assesment.dasar_ketentuan),
      },
    ],
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

  doc
    .fillColor("#0F2A4A")
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(sectionTitle, startX, doc.y);
  doc.moveDown(0.3);

  let currentY = doc.y;
  doc
    .fillColor("#1F3864")
    .rect(startX, currentY, totalWidth, headerHeight)
    .fill();

  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9);

  doc.text("Keterangan", startX + padding, currentY + 6, {
    width: col1Width - padding * 2,
  });
  doc.text("Informasi", startX + col1Width + padding, currentY + 6, {
    width: col2Width - padding * 2,
  });

  currentY += headerHeight;

  dataRows.forEach((row, index) => {
    const label = safeText(row.label, "-");
    const value = safeText(row.value, "-");

    doc.font("Helvetica-Bold").fontSize(8.5);
    const h1 = doc.heightOfString(label, { width: col1Width - padding * 2 });
    doc.font("Helvetica").fontSize(8.5);
    const h2 = doc.heightOfString(value, { width: col2Width - padding * 2 });

    const rowHeight = Math.max(h1, h2) + padding * 2;

    if (currentY + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      currentY = doc.y + 10;
    }

    const bgColor = index % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    doc.fillColor(bgColor).rect(startX, currentY, totalWidth, rowHeight).fill();

    doc
      .strokeColor("#D1D5DB")
      .lineWidth(0.5)
      .rect(startX, currentY, totalWidth, rowHeight)
      .stroke();

    doc
      .moveTo(startX + col1Width, currentY)
      .lineTo(startX + col1Width, currentY + rowHeight)
      .stroke();

    doc
      .fillColor("#1E293B")
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text(label, startX + padding, currentY + padding, {
        width: col1Width - padding * 2,
        align: "left",
      });

    doc
      .fillColor("#334155")
      .font("Helvetica")
      .fontSize(8.5)
      .text(value, startX + col1Width + padding, currentY + padding, {
        width: col2Width - padding * 2,
        align: "left",
      });

    currentY += rowHeight;
  });

  doc.y = currentY + 14;
};


/**
 * Tabel untuk halaman pertama CLAIM ASSESSMENT.
 * Sengaja TIDAK melakukan addPage() agar seluruh assessment tetap berada
 * di halaman pertama. Nilai yang sangat panjang dipadatkan agar tidak
 * menyeberang ke halaman ringkasan JSON.
 */
const truncatePdfText = (value, maxChars = 420) => {
  const text = safeText(value, "-");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trim()}...`;
};

const drawFixedAssessmentSection = (doc, sectionTitle, dataRows, options = {}) => {
  const startX = options.startX || 40;
  const col1Width = options.col1Width || 150;
  const col2Width = options.col2Width || 365;
  const totalWidth = col1Width + col2Width;
  const headerHeight = 20;
  const padding = 5;
  const maxRowHeight = options.maxRowHeight || 34;

  doc
    .fillColor("#0F2A4A")
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .text(sectionTitle, startX, doc.y, { width: totalWidth });
  doc.moveDown(0.2);

  let currentY = doc.y;

  doc.fillColor("#1F3864").rect(startX, currentY, totalWidth, headerHeight).fill();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
  doc.text("Keterangan", startX + padding, currentY + 5, {
    width: col1Width - padding * 2,
  });
  doc.text("Informasi", startX + col1Width + padding, currentY + 5, {
    width: col2Width - padding * 2,
  });

  currentY += headerHeight;

  dataRows.forEach((row, index) => {
    const label = truncatePdfText(row.label, 80);
    const value = truncatePdfText(row.value, 420);

    doc.font("Helvetica-Bold").fontSize(7.8);
    const h1 = doc.heightOfString(label, { width: col1Width - padding * 2 });
    doc.font("Helvetica").fontSize(7.8);
    const h2 = doc.heightOfString(value, { width: col2Width - padding * 2 });
    const rowHeight = Math.min(Math.max(h1, h2) + padding * 2, maxRowHeight);

    const bgColor = index % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    doc.fillColor(bgColor).rect(startX, currentY, totalWidth, rowHeight).fill();
    doc.strokeColor("#D1D5DB").lineWidth(0.4)
      .rect(startX, currentY, totalWidth, rowHeight).stroke();
    doc.moveTo(startX + col1Width, currentY)
      .lineTo(startX + col1Width, currentY + rowHeight).stroke();

    doc.fillColor("#1E293B").font("Helvetica-Bold").fontSize(7.8)
      .text(label, startX + padding, currentY + padding, {
        width: col1Width - padding * 2,
        height: rowHeight - padding * 2,
        ellipsis: true,
      });

    doc.fillColor("#334155").font("Helvetica").fontSize(7.8)
      .text(value, startX + col1Width + padding, currentY + padding, {
        width: col2Width - padding * 2,
        height: rowHeight - padding * 2,
        ellipsis: true,
      });

    currentY += rowHeight;
  });

  doc.y = currentY + 9;
};

/**
 * JSON -> PDF untuk pembaca manusia.
 *
 * Prinsip:
 * - Hanya menampilkan informasi yang relevan untuk penelitian/assessment.
 * - Field teknis seperti schema_version, engine/version, bbox OCR,
 *   model_reference dan input_digest tidak ditampilkan.
 * - Struktur JSON yang penting diringkas menjadi beberapa tabel yang mudah dibaca.
 */
const humanizeKey = (key) => {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const formatJsonDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: value.includes("T") ? "short" : undefined,
  }).format(date);
};

const formatJsonCurrency = (value, currency = "IDR") => {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);

  try {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(number);
  } catch (e) {
    return `Rp ${number.toLocaleString("id-ID")}`;
  }
};

const formatJsonPercent = (value) => {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${(number <= 1 ? number * 100 : number).toFixed(0)}%`;
};

const formatJsonBoolean = (value) => {
  if (value === true) return "Ya";
  if (value === false) return "Tidak";
  return "-";
};

const formatJsonVerdict = (value) => {
  const map = {
    pass: "Terpenuhi",
    fail: "Tidak Terpenuhi",
    not_applicable: "Tidak Berlaku",
    pending: "Menunggu Evaluasi",
  };
  return map[String(value || "").toLowerCase()] || humanizeKey(value || "-");
};

const formatJsonRecommendation = (value) => {
  const map = {
    approve: "Disetujui",
    reject: "Ditolak",
    review: "Perlu Review",
    pending: "Menunggu Evaluasi",
  };
  return map[String(value || "").toLowerCase()] || humanizeKey(value || "-");
};

const getJsonField = (obj, name, fallback = "-") => {
  if (!obj || typeof obj !== "object") return fallback;
  return obj[name] === undefined || obj[name] === null || obj[name] === ""
    ? fallback
    : obj[name];
};

/**
 * Render JSON menjadi lampiran ringkas dan human-readable.
 * Yang ditampilkan adalah informasi substantif, bukan metadata teknis.
 */
const drawJsonAsTable = (doc, dataObject, startX = 40) => {
  const data = dataObject || {};
  const requestRef = getJsonField(data, "request_ref", {});
  const assessment = getJsonField(data, "assessment", {});
  const amount = getJsonField(assessment, "amount", {});
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const policyEvaluation = getJsonField(data, "policy_evaluation", {});
  const rules = Array.isArray(policyEvaluation.rules) ? policyEvaluation.rules : [];
  const audit = getJsonField(data, "audit", {});
  const retention = getJsonField(data, "retention", {});

  // 1. IDENTITAS / REFERENSI UTAMA
  drawTableSection(doc, "Informasi Utama", [
    { label: "Bidang Usaha", value: getJsonField(data, "line_of_business") },
    { label: "ID Proses", value: getJsonField(data, "processing_id") },
    { label: "No. Klaim", value: getJsonField(requestRef, "tpa_claim_id") },
    { label: "Batch Klaim", value: getJsonField(requestRef, "tpa_batch_id") },
    { label: "No. Polis", value: getJsonField(requestRef, "policy_id") },
    { label: "ID Peserta", value: getJsonField(requestRef, "member_id") },
    { label: "Produk", value: getJsonField(requestRef, "product_code") },
    {
      label: "Tanggal Diterima",
      value: formatJsonDate(getJsonField(requestRef, "received_at")),
    },
  ], { startX });

  // 2. DOKUMEN YANG MENJADI DASAR PENILAIAN
  if (documents.length > 0) {
    const rows = documents.map((document, index) => {
      const quality = getJsonField(document, "extraction_quality", {});
      return {
        label: `Dokumen ${index + 1}`,
        value: [
          `Jenis: ${humanizeKey(getJsonField(document, "document_type"))}`,
          `Nama: ${getJsonField(document, "document_id")}`,
          `Jumlah halaman: ${getJsonField(document, "pages")}`,
          `Kualitas ekstraksi: ${formatJsonPercent(getJsonField(quality, "score"))}`,
          `Terbaca: ${formatJsonBoolean(getJsonField(quality, "legible"))}`,
          Array.isArray(quality.issues) && quality.issues.length
            ? `Catatan: ${quality.issues.join(", ")}`
            : "Catatan: Tidak ada",
        ].join("\n"),
      };
    });

    drawTableSection(doc, "Dokumen Sumber", rows, { startX });

    // Field hasil ekstraksi yang substantif saja.
    documents.forEach((document, index) => {
      const fields = Array.isArray(document.fields) ? document.fields : [];
      if (!fields.length) return;

      const fieldRows = fields.map((field) => {
        let value = getJsonField(field, "value");
        const fieldName = String(getJsonField(field, "name", "-"));
        const lowerName = fieldName.toLowerCase();

        if (
          ["invoice_total", "total", "billed", "amount"].some((x) =>
            lowerName.includes(x),
          )
        ) {
          value = formatJsonCurrency(value);
        }

        if (lowerName.includes("date")) {
          value = formatJsonDate(value);
        }

        const confidence = getJsonField(field, "confidence", null);
        if (confidence !== null) {
          value = `${value} (tingkat keyakinan ekstraksi: ${formatJsonPercent(confidence)})`;
        }

        return {
          label: humanizeKey(fieldName),
          value,
        };
      });

      drawTableSection(
        doc,
        `Hasil Ekstraksi - Dokumen ${index + 1}`,
        fieldRows,
        { startX },
      );
    });
  }

  // 3. MANFAAT / KETENTUAN POLIS
  drawTableSection(doc, "Informasi Manfaat", [
    {
      label: "Kode Manfaat",
      value: getJsonField(policyEvaluation, "benefit_code"),
    },
    {
      label: "Jumlah Ketentuan Dievaluasi",
      value: rules.length,
    },
  ], { startX });

  // 4. HASIL EVALUASI KETENTUAN
  if (rules.length > 0) {
    const ruleRows = rules.map((rule, index) => {
      const clause = getJsonField(rule, "source_clause", {});
      const evidence = Array.isArray(rule.evidence) ? rule.evidence : [];
      const notes = evidence
        .filter((item) => item && item.note)
        .map((item) => item.note);

      let value = [
        `Hasil: ${formatJsonVerdict(getJsonField(rule, "verdict"))}`,
        `Rujukan: ${getJsonField(clause, "reference")}`,
      ];

      if (notes.length) value.push(`Bukti/Catatan: ${notes.join("; ")}`);

      return {
        label: `${index + 1}. ${getJsonField(rule, "description", getJsonField(rule, "rule_id"))}`,
        value: value.join("\n"),
      };
    });

    drawTableSection(doc, "Evaluasi Ketentuan Polis", ruleRows, { startX });
  }

  // 5. HASIL AKHIR ASSESSMENT
  drawTableSection(doc, "Hasil Assessment", [
    {
      label: "Rekomendasi",
      value: formatJsonRecommendation(getJsonField(assessment, "recommendation")),
    },
    {
      label: "Tingkat Keyakinan",
      value: formatJsonPercent(getJsonField(assessment, "confidence")),
    },
    {
      label: "Perlu Review Manual",
      value: formatJsonBoolean(getJsonField(assessment, "human_review", {}).required),
    },
  ], { startX });

  // 6. ALASAN KEPUTUSAN
  const reasons = Array.isArray(assessment.reasons) ? assessment.reasons : [];
  if (reasons.length > 0) {
    drawTableSection(doc, "Alasan Keputusan", reasons.map((reason, index) => ({
      label: `${index + 1}. ${getJsonField(reason, "rule_id")}`,
      value: getJsonField(reason, "summary"),
    })), { startX });
  }

  // 7. PERHITUNGAN NILAI KLAIM
  if (Object.keys(amount).length > 0) {
    drawTableSection(doc, "Perhitungan Klaim", [
      { label: "Mata Uang", value: getJsonField(amount, "currency") },
      { label: "Total Tagihan", value: formatJsonCurrency(getJsonField(amount, "billed"), getJsonField(amount, "currency", "IDR")) },
      { label: "Tidak Dijamin", value: formatJsonCurrency(getJsonField(amount, "not_covered"), getJsonField(amount, "currency", "IDR")) },
      { label: "Deductible", value: formatJsonCurrency(getJsonField(amount, "deductible"), getJsonField(amount, "currency", "IDR")) },
      { label: "Co-pay", value: formatJsonCurrency(getJsonField(amount, "copay"), getJsonField(amount, "currency", "IDR")) },
      { label: "Nilai Dapat Dibayar", value: formatJsonCurrency(getJsonField(amount, "payable"), getJsonField(amount, "currency", "IDR")) },
      { label: "Catatan Perhitungan", value: getJsonField(amount, "calculation_note") },
    ], { startX });
  }

  // 8. INFORMASI PROSES YANG MASIH RELEVAN UNTUK PENELITIAN
  drawTableSection(doc, "Informasi Proses", [
    { label: "Waktu Diterima", value: formatJsonDate(getJsonField(audit, "received_at")) },
    { label: "Waktu Selesai", value: formatJsonDate(getJsonField(audit, "completed_at")) },
    { label: "Durasi Proses", value: `${getJsonField(audit, "processing_seconds")} detik` },
  ], { startX });

  // 9. STATUS RETENSI DATA - relevan untuk penelitian tata kelola data.
  if (Object.keys(retention).length > 0) {
    drawTableSection(doc, "Status Retensi Data", [
      { label: "Kebijakan Retensi", value: getJsonField(retention, "policy") },
      { label: "Isi Data Dihapus", value: formatJsonBoolean(getJsonField(retention, "content_deleted")) },
      { label: "Waktu Penghapusan", value: formatJsonDate(getJsonField(retention, "deleted_at")) },
      { label: "Log yang Dipertahankan", value: getJsonField(retention, "log_retained") },
    ], { startX });
  }
};

// --- AUTH ROUTES ---

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("pages/login_new");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const query = "SELECT * FROM users WHERE username = ?";
  db.query(query, [username], async (err, results) => {
    if (err) throw err;

    if (results.length === 0) {
      return res.render("pages/login_new", {
        errorMessage: "Username tidak ditemukan",
      });
    }

    const user = results[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.render("pages/login_new", { errorMessage: "Password salah" });
    }

    req.session.user = user.username;
    req.session.user_id = user.id;
    req.session.role = user.role;

    res.redirect("/dashboard");
  });
});

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("pages/register_new");
});

app.post("/register", async (req, res) => {
  const { username, email, password, passwordConfirm } = req.body;

  if (!username || !email || !password || !passwordConfirm) {
    return res.render("pages/register_new", {
      message: "Please provide all required fields",
    });
  }

  if (password !== passwordConfirm) {
    return res.render("pages/register_new", {
      message: "Passwords do not match",
    });
  }

  const hashedPassword = await bcrypt.hash(password, 8);

  const query = "INSERT INTO users SET ?";
  db.query(
    query,
    {
      username: username,
      email: email,
      password: hashedPassword,
      role: "user",
    },
    (err, result) => {
      if (err) {
        return res.render("pages/register_new", {
          message: "Username or email already exists!",
        });
      }
      return res.render("pages/register_new", {
        message: "User registered successfully!",
      });
    },
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.send("Error");
    res.redirect("/login");
  });
});

// --- DASHBOARD ROUTE ---

app.get("/dashboard", checkAuth, (req, res) => {
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
        res.render("pages/dashboard_new", {
          categories: catResults,
          topPIC: picResults,
          unassigned: unassignedResults[0].count,
          user: req.session.user,
          role: req.session.role,
        });
      });
    });
  });
});

// --- CASES ROUTES ---

app.post(
  "/case/:id/upload-json",
  checkAuth,
  upload.single("json_file"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).send("Silakan pilih file JSON terlebih dahulu.");
    }

    try {
      const parsedJson = JSON.parse(req.file.buffer.toString("utf-8"));
      const jsonString = JSON.stringify(parsedJson);
      const jsonFilePath = saveJsonUploadToDisk(req.file, req.params.id);

      const query =
        "UPDATE cases SET json_data = ?, json_file_path = ? WHERE id = ?";
      db.query(
        query,
        [jsonString, jsonFilePath, req.params.id],
        (err, result) => {
          if (err)
            return res.status(500).send("Database error: " + err.message);
          res.redirect(`/case/${req.params.id}`);
        },
      );
    } catch (err) {
      return res
        .status(400)
        .send("File yang diunggah bukan format JSON yang valid.");
    }
  },
);

/**
 * GENERATE CASE PDF REPORT (Tabel JSON Rapi & Dynamic Footer)
 */
app.get("/case/:id/pdf", checkAuth, (req, res) => {
  const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.id = ?`;

  db.query(query, [req.params.id], (err, results) => {
    if (err) return res.status(500).send("Database error: " + err.message);
    if (results.length === 0) return res.status(404).send("Case not found");

    const caseData = results[0];
    const reportData = normalizeClaimAssessmentData(caseData);

    const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=Claim_Assessment_Case_${caseData.id}.pdf`,
    );
    doc.pipe(res);

    const logoPath = path.join(__dirname, "uploads", "logo.png");

    // ================= HALAMAN 1: CLAIM ASSESSMENT =================
    // Halaman pertama dibuat khusus sebagai ringkasan keputusan/assessment.
    // Halaman kedua baru digunakan untuk ringkasan data JSON.
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 425, 24, { fit: [130, 42], align: "right" });
    }

    // Header dokumen
    doc
      .fillColor("#0F2A4A")
      .font("Helvetica-Bold")
      .fontSize(17)
      .text("CLAIM ASSESSMENT", 40, 28, { width: 360 });

    doc
      .fillColor("#64748B")
      .font("Helvetica")
      .fontSize(8.5)
      .text("Ringkasan hasil pemeriksaan dan penilaian klaim", 40, 50);

    // Garis identitas laporan
    doc
      .strokeColor("#CBD5E1")
      .lineWidth(0.8)
      .moveTo(40, 68)
      .lineTo(doc.page.width - 40, 68)
      .stroke();

    doc.y = 80;

    // Informasi ringkas dokumen/case
    drawFixedAssessmentSection(doc, "INFORMASI POLIS", reportData.informasi_polis, {
      startX: 40,
      col1Width: 150,
      col2Width: 365,
      maxRowHeight: 31,
    });

    drawFixedAssessmentSection(doc, "INFORMASI KLAIM", reportData.informasi_klaim, {
      startX: 40,
      col1Width: 150,
      col2Width: 365,
      maxRowHeight: 34,
    });

    drawFixedAssessmentSection(doc, "HASIL CLAIM ASSESSMENT", reportData.claim_assesment, {
      startX: 40,
      col1Width: 150,
      col2Width: 365,
      maxRowHeight: 34,
    });

    // Penanda bahwa halaman ini adalah halaman keputusan/assessment,
    // sedangkan rincian JSON berada pada halaman berikutnya.
    const noteY = Math.min(doc.y + 2, doc.page.height - 82);
    doc.fillColor("#F1F5F9").roundedRect(40, noteY, 515, 30, 4).fill();
    doc.fillColor("#475569").font("Helvetica-Oblique").fontSize(7.5)
      .text(
        "Catatan: rincian data sumber dan hasil evaluasi JSON disajikan mulai halaman berikutnya.",
        50,
        noteY + 9,
        { width: 495, align: "center" },
      );
    doc.y = noteY + 38;

    // ================= RINGKASAN DATA JSON =================
    // Tidak ada page break paksa. Jika konten assessment sudah penuh,
    // PDFKit akan membuat halaman baru secara natural. Ringkasan JSON
    // langsung dilanjutkan setelah konten assessment.
    if (caseData.json_data) {
      try {
        const parsedObj = resolveCaseJsonData(caseData);
        if (parsedObj && Object.keys(parsedObj).length > 0) {
          doc.moveDown(1);
          doc
            .fillColor("#0F2A4A")
            .font("Helvetica-Bold")
            .fontSize(14)
            .text("RINGKASAN DATA JSON", 40, doc.y, { width: 515 });

          doc
            .fillColor("#64748B")
            .font("Helvetica")
            .fontSize(8.5)
            .text(
              "Informasi substantif yang relevan untuk penelitian dan pembacaan manusia.",
              40,
              doc.y + 4,
              { width: 515 },
            );

          doc.y += 20;
          drawJsonAsTable(doc, parsedObj, 40);
        } else {
          doc
            .fillColor("#DC2626")
            .font("Helvetica")
            .fontSize(9)
            .text("Data JSON tidak dapat diurai ke dalam bentuk ringkasan.", 40, doc.y);
        }
      } catch (e) {
        doc
          .fillColor("#DC2626")
          .font("Helvetica")
          .fontSize(9)
          .text("Data JSON tidak dapat diurai ke dalam bentuk ringkasan.", 40, doc.y);
      }
    }

    // Tidak menggunakan footer, nomor halaman, atau page break manual.
    // PDFKit hanya akan menambah halaman jika konten memang melewati batas halaman.
    doc.end();
  });
});

/**
 * ALL CASES
 */
app.get("/all-cases", checkAuth, (req, res) => {
  const query = `
        SELECT c.*, u.username as pic_name, u.id as pic_id_check
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        ORDER BY c.id DESC`;

  db.query(query, (err, results) => {
    if (err) throw err;
    res.render("pages/all_cases_new", {
      cases: results,
      user: req.session.user,
      role: req.session.role,
    });
  });
});

/**
 * CASES BY CATEGORY
 */
app.get("/cases/:type", checkAuth, (req, res) => {
  const { type } = req.params;

  const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.type = ?
        ORDER BY c.id DESC`;

  db.query(query, [type], (err, results) => {
    if (err) throw err;
    res.render("pages/cases_by_type_new", {
      cases: results,
      type: type,
      user: req.session.user,
      role: req.session.role,
    });
  });
});

/**
 * CREATE NEW CASE
 */
app.get("/case/new", checkAuth, (req, res) => {
  if (!canCreateCase(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  res.render("pages/case_form_new", {
    caseItem: null,
    caseTypes: ["Regular Case", "On-Desk Case", "Reliance Case"],
    user: req.session.user,
    role: req.session.role,
  });
});

app.post("/case/new", checkAuth, (req, res) => {
  if (!canCreateCase(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
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
    dasar_ketentuan,
  } = req.body;

  const sql = "INSERT INTO cases SET ?";
  db.query(
    sql,
    {
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
      status_claim: status_claim || "Unassigned",
      hasil_assesment: hasil_assesment || null,
      dasar_ketentuan: dasar_ketentuan || null,
      status: "Unassigned",
    },
    (err, result) => {
      if (err) {
        return res.render("pages/case_form_new", {
          message: "Error creating case: " + err.message,
          caseItem: null,
          caseTypes: ["Regular Case", "On-Desk Case", "Reliance Case"],
          user: req.session.user,
          role: req.session.role,
        });
      }
      res.redirect("/all-cases");
    },
  );
});

/**
 * EDIT CASE
 */
app.get("/case/:id/edit", checkAuth, (req, res) => {
  if (!canCreateCase(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  const query = "SELECT * FROM cases WHERE id = ?";
  db.query(query, [req.params.id], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.status(404).send("Case not found");
    res.render("pages/case_form_new", {
      caseItem: results[0],
      caseTypes: ["Regular Case", "On-Desk Case", "Reliance Case"],
      user: req.session.user,
      role: req.session.role,
    });
  });
});

app.post("/case/:id/edit", checkAuth, (req, res) => {
  if (!canCreateCase(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
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
    dasar_ketentuan,
  } = req.body;

  const sql = `UPDATE cases SET title = ?, description = ?, priority = ?, status = ?,
        no_polis = ?, pemegang_polis = ?, tertanggung = ?, tanggal_issued_polis = ?, jenis_claim = ?, up = ?,
        usia_polis = ?, pekerjaan_tertanggung = ?, alamat = ?, tanggal_meninggal = ?, penyebab_meninggal = ?,
        tempat_meninggal = ?, pengaju_klaim = ?, kronologi_singkat = ?, status_claim = ?, hasil_assesment = ?,
        dasar_ketentuan = ? WHERE id = ?`;
  db.query(
    sql,
    [
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
      req.params.id,
    ],
    (err, result) => {
      if (err) throw err;
      res.redirect(`/case/${req.params.id}`);
    },
  );
});

/**
 * DELETE CASE
 */
app.post("/case/:id/delete", checkAuth, (req, res) => {
  if (!["admin", "spv"].includes(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  const sql = "DELETE FROM cases WHERE id = ?";
  db.query(sql, [req.params.id], (err, result) => {
    if (err) throw err;
    res.redirect("/all-cases");
  });
});

/**
 * CASE DETAIL
 */
app.get("/case/:id", checkAuth, (req, res) => {
  const query = `
        SELECT c.*, u.username as pic_name 
        FROM cases c 
        LEFT JOIN users u ON c.pic_id = u.id
        WHERE c.id = ?`;

  db.query(query, [req.params.id], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.status(404).send("Case not found");

    const caseData = results[0];
    const documentQuery =
      "SELECT * FROM case_documents WHERE case_id = ? ORDER BY created_at DESC";

    db.query(documentQuery, [req.params.id], (docErr, documentResults) => {
      if (docErr) {
        if (docErr.code === "ER_NO_SUCH_TABLE") {
          return res.render("pages/case_detail_new", {
            caseItem: caseData,
            documents: [],
            user: req.session.user,
            role: req.session.role,
            userId: req.session.user_id,
          });
        }
        throw docErr;
      }

      res.render("pages/case_detail_new", {
        caseItem: caseData,
        documents: documentResults,
        user: req.session.user,
        role: req.session.role,
        userId: req.session.user_id,
      });
    });
  });
});

/**
 * GET ALL USERS WITH CURRENT LOAD
 */
app.get(
  "/api/users-with-load",
  checkAuth,
  checkRole(["admin", "spv"]),
  (req, res) => {
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
  },
);

/**
 * ASSIGN CASE TO PIC
 */
app.post("/assign-case", checkAuth, checkRole(["admin", "spv"]), (req, res) => {
  const { case_id, pic_id } = req.body;

  if (!pic_id) {
    return res.json({
      success: false,
      error: "Please select a user to assign",
    });
  }

  const sql =
    "UPDATE cases SET pic_id = ?, status = 'In Progress' WHERE id = ?";
  db.query(sql, [pic_id, case_id], (err, result) => {
    if (err) return res.json({ success: false, error: err.message });
    if (result.affectedRows === 0)
      return res.json({ success: false, error: "Case not found" });

    res.json({ success: true });
  });
});

/**
 * UPDATE CASE STATUS
 */
app.post("/update-case-status", checkAuth, (req, res) => {
  const { case_id, status } = req.body;

  if (!status) {
    return res.json({ success: false, error: "Please select a status" });
  }

  const checkQuery = "SELECT pic_id FROM cases WHERE id = ?";
  db.query(checkQuery, [case_id], (err, results) => {
    if (err) {
      return res.json({ success: false, error: err.message });
    }
    if (results.length === 0) {
      return res.json({ success: false, error: "Case not found" });
    }

    const caseData = results[0];
    if (
      req.session.role === "user" &&
      caseData.pic_id !== req.session.user_id
    ) {
      return res.json({
        success: false,
        error: "Unauthorized - only assigned PIC can update this case",
      });
    }

    const sql = "UPDATE cases SET status = ? WHERE id = ?";
    db.query(sql, [status, case_id], (err, result) => {
      if (err) {
        return res.json({ success: false, error: err.message });
      }
      if (result.affectedRows === 0) {
        return res.json({ success: false, error: "Case not found" });
      }

      res.json({ success: true });
    });
  });
});

// --- USER MANAGEMENT ROUTES ---

app.get("/users", checkAuth, checkRole(["admin"]), (req, res) => {
  const query =
    "SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC";
  db.query(query, (err, results) => {
    if (err) throw err;
    res.render("pages/users_list_new", {
      users: results,
      user: req.session.user,
      role: req.session.role,
    });
  });
});

app.get("/user/new", checkAuth, checkRole(["admin"]), (req, res) => {
  res.render("pages/user_form_new", {
    user: null,
    roles: ["admin", "spv", "user"],
    currentUser: req.session.user,
  });
});

app.post("/user/new", checkAuth, checkRole(["admin"]), async (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password) {
    return res.render("pages/user_form_new", {
      message: "All fields required",
      user: null,
      roles: ["admin", "spv", "user"],
      currentUser: req.session.user,
    });
  }

  const hashedPassword = await bcrypt.hash(password, 8);
  const sql = "INSERT INTO users SET ?";

  db.query(
    sql,
    {
      username: username,
      email: email,
      password: hashedPassword,
      role: role,
    },
    (err, result) => {
      if (err) {
        return res.render("pages/user_form_new", {
          message: "Username or email already exists!",
          user: null,
          roles: ["admin", "spv", "user"],
          currentUser: req.session.user,
        });
      }
      res.redirect("/users");
    },
  );
});

app.get("/user/:id/edit", checkAuth, checkRole(["admin"]), (req, res) => {
  const query = "SELECT * FROM users WHERE id = ?";
  db.query(query, [req.params.id], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.status(404).send("User not found");
    res.render("pages/user_form_new", {
      user: results[0],
      roles: ["admin", "spv", "user"],
      currentUser: req.session.user,
    });
  });
});

app.post(
  "/user/:id/edit",
  checkAuth,
  checkRole(["admin"]),
  async (req, res) => {
    const { username, email, role, password } = req.body;

    let query, params;

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 8);
      query =
        "UPDATE users SET username = ?, email = ?, role = ?, password = ? WHERE id = ?";
      params = [username, email, role, hashedPassword, req.params.id];
    } else {
      query = "UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?";
      params = [username, email, role, req.params.id];
    }

    db.query(query, params, (err, result) => {
      if (err) throw err;
      res.redirect("/users");
    });
  },
);

app.post("/user/:id/delete", checkAuth, checkRole(["admin"]), (req, res) => {
  const unassignQuery = "UPDATE cases SET pic_id = NULL WHERE pic_id = ?";
  db.query(unassignQuery, [req.params.id], (err) => {
    if (err) throw err;

    const deleteQuery = "DELETE FROM users WHERE id = ?";
    db.query(deleteQuery, [req.params.id], (err, result) => {
      if (err) throw err;
      res.redirect("/users");
    });
  });
});

// --- FILE UPLOADS ---

const caseDocumentStorage = multer.diskStorage({
  destination: path.join(__dirname, "uploads", "case-documents"),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`);
  },
});

const caseDocumentUpload = multer({
  storage: caseDocumentStorage,
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files allowed for case document upload"));
    }
  },
});

const importStorage = multer.diskStorage({
  destination: path.join(__dirname, "uploads"),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`);
  },
});

const importUpload = multer({
  storage: importStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedTypes = [".csv", ".xls", ".xlsx"];
    const mimeTypes = [
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];

    if (allowedTypes.includes(ext) || mimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV, XLS, or XLSX files are allowed"));
    }
  },
});

const parseImportRows = (filePath) => {
  return new Promise((resolve, reject) => {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".csv") {
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on("data", (row) => rows.push(row))
        .on("end", () => resolve(rows))
        .on("error", reject);
      return;
    }

    try {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(worksheet, {
        defval: "",
        raw: false,
      });
      resolve(rows);
    } catch (error) {
      reject(error);
    }
  });
};

// --- CSV / EXCEL IMPORT ROUTE ---

app.get("/import-cases", checkAuth, (req, res) => {
  if (!canImportCases(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  res.render("pages/import_cases_new", {
    user: req.session.user,
    role: req.session.role,
  });
});

app.post("/import-cases", checkAuth, (req, res) => {
  if (!canImportCases(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  importUpload.single("file")(req, res, async (err) => {
    if (err) {
      return res.render("pages/import_cases_new", {
        message: "Error: " + err.message,
        user: req.session.user,
        role: req.session.role,
      });
    }

    if (!req.file) {
      return res.render("pages/import_cases_new", {
        message: "Please select a CSV or Excel file to import.",
        user: req.session.user,
        role: req.session.role,
      });
    }

    const filePath = req.file.path;
    let rows = [];
    let successCount = 0;
    let errorCount = 0;

    try {
      rows = await parseImportRows(filePath);

      const sql =
        "INSERT INTO cases (type, title, description, priority, status) VALUES (?, ?, ?, ?, ?)";

      for (const row of rows) {
        const type = (row.type || row.Type || "").toString().trim();
        const title = (row.title || row.Title || "").toString().trim();
        const description = (row.description || row.Description || "")
          .toString()
          .trim();
        const priority = (row.priority || row.Priority || "Medium")
          .toString()
          .trim();
        const status = (row.status || row.Status || "Unassigned")
          .toString()
          .trim();

        if (!type || !title) {
          errorCount++;
          continue;
        }

        const validType = [
          "Regular Case",
          "On-Desk Case",
          "Reliance Case",
        ].includes(type);
        const validPriority = ["Low", "Medium", "High"].includes(priority);
        const validStatus = [
          "Unassigned",
          "In Progress",
          "On Hold",
          "Closed",
        ].includes(status);

        if (!validType || !validPriority || !validStatus) {
          errorCount++;
          continue;
        }

        const insertResult = await new Promise((resolve, reject) => {
          db.query(
            sql,
            [type, title, description || "", priority, status],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            },
          );
        });

        if (insertResult) {
          successCount++;
        }
      }

      res.render("pages/import_cases_new", {
        message: `Import complete! Success: ${successCount}, Failed: ${errorCount}`,
        importResult: {
          total: rows.length,
          success: successCount,
          failed: errorCount,
        },
        user: req.session.user,
        role: req.session.role,
      });
    } catch (err) {
      res.render("pages/import_cases_new", {
        message: "Error reading CSV/Excel file: " + err.message,
        user: req.session.user,
        role: req.session.role,
      });
    } finally {
      if (req.file && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
});

app.post("/case/:id/upload-document", checkAuth, (req, res) => {
  if (!canUploadCaseDocument(req.session.role)) {
    return res.status(403).send("Unauthorized Access");
  }

  caseDocumentUpload.single("document")(req, res, (err) => {
    if (err) {
      return res.status(400).send("Error uploading PDF: " + err.message);
    }

    if (!req.file) {
      return res.status(400).send("No PDF file uploaded");
    }

    const sql =
      "INSERT INTO case_documents (case_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?)";
    db.query(
      sql,
      [
        req.params.id,
        req.file.filename,
        req.file.originalname,
        req.session.user_id,
      ],
      (uploadErr) => {
        if (uploadErr) {
          fs.unlinkSync(req.file.path);
          return res
            .status(500)
            .send("Failed to save document: " + uploadErr.message);
        }

        res.redirect(`/case/${req.params.id}`);
      },
    );
  });
});

// --- ROOT ROUTE ---

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

// --- ERROR HANDLING ---
app.use((req, res) => {
  res.status(404).send("Page not found");
});

// --- PORT SETUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { db };
