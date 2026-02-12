const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// Load secrets from env or fallback to files
const API_KEY = (process.env.API_KEY || (() => {
  try { return fs.readFileSync(path.join(__dirname, 'api_key.txt'), 'utf8'); } catch { return ''; }
})()).replace(/\s/g, '');
const ADMIN_KEY = (process.env.ADMIN_KEY || (() => {
  try { return fs.readFileSync(path.join(__dirname, 'admin_pass.txt'), 'utf8'); } catch { return ''; }
})()).replace(/\s/g, '');

// Directories
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_BASE = path.join(__dirname, 'uploads');
const CSV_PATH = path.join(DATA_DIR, 'submissions.csv');

[DATA_DIR, UPLOADS_BASE].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// CSV headers
const CSV_HEADERS = ['id', 'timestamp', 'formPurpose', 'firstName', 'lastName', 'email', 'phone', 'helpNeededOffered', 'additionalMaterialsPaths'];

function ensureCsvExists() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, stringify([CSV_HEADERS]));
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// File upload: organize by YYYY/MM/DD/submissionId/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const subId = req.submissionId || generateId();
    req.submissionId = subId;
    const dir = path.join(UPLOADS_BASE, String(y), m, d, subId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8') || 'file';
    const ext = path.extname(safe) || '';
    const base = path.basename(safe, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'file';
    cb(null, `${base}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => cb(null, true)
});

ensureCsvExists();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TechHelpSeniors', timestamp: new Date().toISOString() });
});

// API: submit form (requires api_key header or query)
app.post('/api/submit', upload.array('additionalMaterials', 10), (req, res) => {
  const rawKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || req.query?.api_key || req.body?.api_key;
  const key = (rawKey || '').replace(/\s/g, '');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  const id = req.submissionId || generateId();
  const timestamp = new Date().toISOString();
  const formPurpose = req.body.formPurpose || '';
  const firstName = req.body.firstName || '';
  const lastName = req.body.lastName || '';
  const email = req.body.email || '';
  const phone = req.body.phone || '';
  const helpNeededOffered = req.body.helpNeededOffered || '';

  const files = req.files || [];
  const relPaths = files.map(f => path.relative(__dirname, f.path).replace(/\\/g, '/'));

  const row = [id, timestamp, formPurpose, firstName, lastName, email, phone, helpNeededOffered, relPaths.join('|')];
  const csvLine = stringify([row], { header: false });
  fs.appendFileSync(CSV_PATH, csvLine);

  res.status(201).json({
    success: true,
    id,
    message: 'Form submitted successfully'
  });
});

// Admin page: require ?key=ADMIN_KEY
app.get('/admin', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).send(`
      <!DOCTYPE html><html><head><title>Access Denied</title></head>
      <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;">
        <p style="color:#c00;">Access denied. Invalid or missing key.</p>
      </body></html>
    `);
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API: get submissions (admin only, for the admin page)
app.get('/api/submissions', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { skip_empty_lines: true, relax_column_count: true });
  const [header, ...data] = rows;
  const submissions = data.map(row => {
    const obj = {};
    (header || CSV_HEADERS).forEach((h, i) => obj[h] = row[i] || '');
    if (obj.additionalMaterialsPaths) {
      obj.additionalMaterialsPaths = obj.additionalMaterialsPaths.split('|').filter(Boolean);
    }
    return obj;
  });

  res.json(submissions.reverse());
});

// Serve uploaded files (admin only, for viewing)
app.get(/^\/api\/files\/(.+)$/, (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }
  let relPath = (req.path.match(/^\/api\/files\/(.+)$/)?.[1] || '');
  try { relPath = decodeURIComponent(relPath); } catch { relPath = ''; }
  relPath = relPath.replace(/\.\./g, '');
  const fullPath = path.resolve(path.join(__dirname, relPath));
  const uploadsDir = path.resolve(UPLOADS_BASE);
  if (!fullPath.startsWith(uploadsDir + path.sep) && fullPath !== uploadsDir) {
    return res.status(403).send('Forbidden');
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).send('Not found');
  }
  res.sendFile(fullPath);
});

app.listen(PORT, () => {
  console.log(`TechHelpSeniors server running on port ${PORT}`);
});
