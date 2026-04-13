const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// Load secrets: on Render use env vars only; locally use env then file fallback
const IS_RENDER = process.env.RENDER === 'true';
function loadSecret(envKey, altEnvKey, filePath) {
  const fromEnv = process.env[envKey] || (altEnvKey ? process.env[altEnvKey] : '') || '';
  if (IS_RENDER) return (fromEnv || '').replace(/\s/g, '');
  if (fromEnv) return fromEnv.replace(/\s/g, '');
  try {
    return (fs.readFileSync(path.join(__dirname, filePath), 'utf8') || '').replace(/\s/g, '');
  } catch {
    return '';
  }
}
const API_KEY = loadSecret('API_KEY', null, 'api_key.txt');
const ADMIN_KEY = loadSecret('ADMIN_KEY', 'ADMIN_PASS', 'admin_pass.txt');

// Directories — Render sets DATA_PATH to disk mount; locally use ./storage under the app
const STORAGE_ROOT = process.env.DATA_PATH || path.join(__dirname, 'storage');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const UPLOADS_BASE = path.join(STORAGE_ROOT, 'uploads');
const CSV_PATH = path.join(DATA_DIR, 'submissions.csv');
const NOTES_PATH = path.join(DATA_DIR, 'notes.json');

[DATA_DIR, UPLOADS_BASE].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// CSV headers — status workflow: new → triaged → in_progress → resolved
const CSV_HEADERS = ['id', 'timestamp', 'formPurpose', 'firstName', 'lastName', 'email', 'phone', 'helpNeededOffered', 'status', 'additionalMaterialsPaths'];
const SUBMISSION_STATUSES = ['new', 'triaged', 'in_progress', 'resolved'];

function normalizeStatus(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (SUBMISSION_STATUSES.includes(s)) return s;
  return 'new';
}

function statusFromId(id) {
  let h = 0;
  const str = String(id);
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  return SUBMISSION_STATUSES[Math.abs(h) % SUBMISSION_STATUSES.length];
}

function ensureCsvExists() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, stringify([CSV_HEADERS]));
  }
}

function migrateSubmissionsCsvIfNeeded() {
  if (!fs.existsSync(CSV_PATH)) return;
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { skip_empty_lines: true, relax_column_count: true });
  if (rows.length === 0) return;
  const header = rows[0];
  if (header.includes('status')) return;
  const newRows = [CSV_HEADERS];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = (row[0] || '').trim();
    const paths = row[8] != null ? row[8] : '';
    const st = statusFromId(id);
    newRows.push([...row.slice(0, 8), st, paths]);
  }
  fs.writeFileSync(CSV_PATH, stringify(newRows));
}

function readNotes() {
  try {
    const raw = fs.readFileSync(NOTES_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeNotes(notes) {
  fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2));
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
migrateSubmissionsCsvIfNeeded();

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
  const relPaths = files.map(f => path.relative(STORAGE_ROOT, f.path).replace(/\\/g, '/'));

  const row = [id, timestamp, formPurpose, firstName, lastName, email, phone, helpNeededOffered, 'new', relPaths.join('|')];
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
    obj.status = normalizeStatus(obj.status);
    return obj;
  });

  res.json(submissions.reverse());
});

// API: update submission status (admin only)
app.patch('/api/submissions/:id', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return res.status(400).json({ error: 'Invalid submission id' });
  }

  const nextStatus = normalizeStatus(req.body?.status);
  if (!SUBMISSION_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ error: 'Invalid status', allowed: SUBMISSION_STATUSES });
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { skip_empty_lines: true, relax_column_count: true });
  const [header, ...data] = rows;
  const h = header || CSV_HEADERS;
  const statusIdx = h.indexOf('status');
  if (statusIdx < 0) {
    return res.status(500).json({ error: 'CSV missing status column' });
  }

  const idx = data.findIndex(row => (row[0] || '').trim() === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  const row = [...data[idx]];
  while (row.length < h.length) row.push('');
  row[statusIdx] = nextStatus;
  data[idx] = row;

  fs.writeFileSync(CSV_PATH, stringify([h, ...data]));
  res.json({ success: true, id, status: nextStatus });
});

// API: delete submission (admin only)
app.delete('/api/submissions/:id', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return res.status(400).json({ error: 'Invalid submission id' });
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, { skip_empty_lines: true, relax_column_count: true });
  const [header, ...data] = rows;
  const idx = data.findIndex(row => (row[0] || '').trim() === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  const deleted = data[idx];
  const pathsCol = (header || CSV_HEADERS).indexOf('additionalMaterialsPaths');
  const pathsRaw = pathsCol >= 0 ? (deleted[pathsCol] || '') : '';
  const paths = pathsRaw.split('|').filter(Boolean);

  for (const p of paths) {
    const fullPath = path.resolve(path.join(STORAGE_ROOT, p));
    if (fullPath.startsWith(path.resolve(UPLOADS_BASE))) {
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          fs.unlinkSync(fullPath);
        }
      } catch (_) {}
    }
  }

  const dirsToRemove = new Set();
  for (const p of paths) {
    let d = path.dirname(p);
    while (d && d !== '.' && d.startsWith('uploads')) {
      dirsToRemove.add(path.join(STORAGE_ROOT, d));
      d = path.dirname(d);
    }
  }
  for (const dir of [...dirsToRemove].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (_) {}
  }

  const remaining = data.filter((_, i) => i !== idx);
  const newCsv = stringify([header || CSV_HEADERS, ...remaining]);
  fs.writeFileSync(CSV_PATH, newCsv);

  res.json({ success: true, id });
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
  const fullPath = path.resolve(path.join(STORAGE_ROOT, relPath));
  const uploadsDir = path.resolve(UPLOADS_BASE);
  if (!fullPath.startsWith(uploadsDir + path.sep) && fullPath !== uploadsDir) {
    return res.status(403).send('Forbidden');
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).send('Not found');
  }
  res.sendFile(fullPath);
});

// Notes (admin only) — JSON file in data dir
app.get('/api/notes', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const notes = readNotes().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const title = String(req.body?.title || '').trim().slice(0, 300);
  const body = String(req.body?.body || '').slice(0, 50000);
  const linkedRaw = req.body?.linkedSubmissionId;
  const linkedSubmissionId =
    linkedRaw != null && String(linkedRaw).trim() !== ''
      ? String(linkedRaw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
      : '';
  if (!title && !body) {
    return res.status(400).json({ error: 'Title or body is required' });
  }
  const now = new Date().toISOString();
  const note = {
    id: generateId(),
    title: title || '(Untitled)',
    body,
    createdAt: now,
    updatedAt: now,
    linkedSubmissionId
  };
  const notes = readNotes();
  notes.push(note);
  writeNotes(notes);
  res.status(201).json(note);
});

app.put('/api/notes/:id', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return res.status(400).json({ error: 'Invalid note id' });
  }
  const notes = readNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Note not found' });
  }
  const titleIn = req.body?.title;
  const bodyIn = req.body?.body;
  const linkedIn = req.body?.linkedSubmissionId;
  if (titleIn !== undefined) notes[idx].title = String(titleIn).trim().slice(0, 300) || '(Untitled)';
  if (bodyIn !== undefined) notes[idx].body = String(bodyIn).slice(0, 50000);
  if (linkedIn !== undefined) {
    notes[idx].linkedSubmissionId =
      linkedIn != null && String(linkedIn).trim() !== ''
        ? String(linkedIn).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
        : '';
  }
  notes[idx].updatedAt = new Date().toISOString();
  writeNotes(notes);
  res.json(notes[idx]);
});

app.delete('/api/notes/:id', (req, res) => {
  const key = (req.query.key || '').replace(/\s/g, '');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) {
    return res.status(400).json({ error: 'Invalid note id' });
  }
  const notes = readNotes();
  const next = notes.filter(n => n.id !== id);
  if (next.length === notes.length) {
    return res.status(404).json({ error: 'Note not found' });
  }
  writeNotes(next);
  res.json({ success: true, id });
});

app.listen(PORT, () => {
  console.log(`TechHelpSeniors server running on port ${PORT}`);
});
