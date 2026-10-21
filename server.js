/**
 * Teams HRIS — Backend API Server
 * Node.js + Express + JSON file storage (no SQLite needed)
 * Port: 3001  |  start: node server.js
 */

const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { Pool }  = require('pg');

const PORT             = process.env.PORT || 3001;
const JWT_SECRET       = process.env.JWT_SECRET || 'teams-hris-secret-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient     = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const DATA_DIR         = path.join(__dirname, 'data');
const STORE_FILE       = path.join(DATA_DIR, 'hris.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// PostgreSQL pool — connects only when DATABASE_URL env var is set (Railway addon)
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ══════════════════════════════════════
//  PURE-JS DATA STORE
// ══════════════════════════════════════
const DEFAULT_DEPTS = ['Human Resources','Engineering','Design','Sales','Marketing','Finance','Operations','IT & Operations','Technology'];

let store = {
  users: [], employees: [], attendance: [],
  leave_requests: [], ot_requests: [], inbox: [],
  appointments: [], holidays: [], _seq: {},
  departments: [],      // admin-managed department list
  cal_notes: {},        // { userId: { "YYYY-MM-DD": "note text" } }
  settings: {}          // { approval_chain: { leave, ot, comp } }
};

const STORE_KEYS = ['users','employees','attendance','leave_requests','ot_requests','inbox','appointments','holidays','_seq','departments','cal_notes','settings'];

async function loadStore() {
  if (pgPool) {
    try {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
      const r = await pgPool.query("SELECT value FROM kv WHERE key='store'");
      if (r.rows.length) {
        const d = JSON.parse(r.rows[0].value);
        STORE_KEYS.forEach(k => { if (d[k] !== undefined) store[k] = d[k]; });
        console.log('Store loaded from PostgreSQL ✓');
        return;
      }
    } catch(e) { console.error('PG load error:', e.message); }
  }
  // Fallback: file (local dev)
  if (fs.existsSync(STORE_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      STORE_KEYS.forEach(k => { if (d[k] !== undefined) store[k] = d[k]; });
      console.log('Store loaded from file:', STORE_FILE);
    } catch(e) { console.error('Load error:', e.message); }
  }
}

function saveDb() {
  const json = JSON.stringify(store);
  if (pgPool) {
    pgPool.query(
      "INSERT INTO kv(key,value) VALUES('store',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [json]
    ).catch(e => console.error('PG save error:', e.message));
    return;
  }
  try { fs.writeFileSync(STORE_FILE, json); }
  catch(e) { console.error('Save error:', e.message); }
}

// ── Time helpers — all business dates/times are Thailand time (server runs in UTC on Render) ──
const TZ = 'Asia/Bangkok';
function bkkToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function bkkNowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date());
}
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_EMAIL = /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/;
const isDate = s => typeof s === 'string' && RE_DATE.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const toMin  = s => +s.slice(0,2) * 60 + +s.slice(3,5);
const fmtDur = m => Math.floor(m/60) + 'h ' + String(m%60).padStart(2,'0') + 'm';
const MANAGER_ROLES = ['admin','hr_manager','hr_staff'];
// Approval chain: minimum role needed to approve each request type (admin can always approve)
const ROLE_RANK = { employee: 0, hr_staff: 1, hr_manager: 2, admin: 3 };
const DEFAULT_CHAIN = { leave: 'hr_manager', ot: 'hr_manager', comp: 'admin' };
function approvalChain() { return { ...DEFAULT_CHAIN, ...((store.settings || {}).approval_chain || {}) }; }
function canDecide(role, type) { return (ROLE_RANK[role] || 0) >= (ROLE_RANK[approvalChain()[type]] || 2); }
const isManagerRole = r => MANAGER_ROLES.includes(r);

function notify(fromId, toId, subject, body) {
  if (!toId) return;
  store.inbox.push({ id: genId('inbox'), from_user: fromId, to_user: toId, subject, body: body||'', is_read: 0, created_at: new Date().toISOString() });
}
function nextEmpId() {
  const nums = store.employees.map(e => parseInt(String(e.emp_id||'').replace(/\D/g,''), 10) || 0);
  return 'EMP-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3,'0');
}

function genId(table) {
  const rows = store[table];
  if (!store._seq[table]) {
    store._seq[table] = rows.length > 0 ? Math.max(...rows.map(r => r.id || 0)) + 1 : 1;
  }
  const id = store._seq[table]++;
  return id;
}

// ══════════════════════════════════════
//  ROLE DEFAULTS
// ══════════════════════════════════════
const ROLE_DEFAULTS = {
  admin:      ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','payroll','recruitment','permissions','myrecords'],
  hr_manager: ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','payroll','recruitment','myrecords'],
  hr_staff:   ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','myrecords'],
  employee:   ['checkin','ot','inbox','calendar','leave','myrecords'],
};

// Official financial-institution (bank) holidays announced by the Bank of Thailand.
// 2569/2026: BOT Notification 31/2568 · 2570/2027: BOT Notification 37/2569
const BANK_HOLIDAYS = {
  2026: [
    ['2026-01-01','วันขึ้นปีใหม่','official'],['2026-01-02','วันหยุดพิเศษ (ครม.)','special'],['2026-03-03','วันมาฆบูชา','official'],
    ['2026-04-06','วันจักรี','official'],['2026-04-13','วันสงกรานต์','official'],['2026-04-14','วันสงกรานต์','official'],['2026-04-15','วันสงกรานต์','official'],
    ['2026-05-01','วันแรงงานแห่งชาติ','official'],['2026-05-04','วันฉัตรมงคล','official'],['2026-06-01','ชดเชยวันวิสาขบูชา (31 พ.ค.)','compensatory'],
    ['2026-06-03','วันเฉลิมพระชนมพรรษา พระราชินี','official'],['2026-07-28','วันเฉลิมพระชนมพรรษา ร.10','official'],['2026-07-29','วันอาสาฬหบูชา','official'],
    ['2026-08-12','วันแม่แห่งชาติ','official'],['2026-10-13','วันนวมินทรมหาราช','official'],['2026-10-23','วันปิยมหาราช','official'],
    ['2026-12-07','ชดเชยวันพ่อแห่งชาติ (5 ธ.ค.)','compensatory'],['2026-12-10','วันรัฐธรรมนูญ','official'],['2026-12-31','วันสิ้นปี','official'],
  ],
  2027: [
    ['2027-01-01','วันขึ้นปีใหม่','official'],['2027-02-22','ชดเชยวันมาฆบูชา (21 ก.พ.)','compensatory'],['2027-04-06','วันจักรี','official'],
    ['2027-04-13','วันสงกรานต์','official'],['2027-04-14','วันสงกรานต์','official'],['2027-04-15','วันสงกรานต์','official'],
    ['2027-05-03','ชดเชยวันแรงงานแห่งชาติ (1 พ.ค.)','compensatory'],['2027-05-04','วันฉัตรมงคล','official'],['2027-05-20','วันวิสาขบูชา','official'],
    ['2027-06-03','วันเฉลิมพระชนมพรรษา พระราชินี','official'],['2027-07-19','ชดเชยวันอาสาฬหบูชา (18 ก.ค.)','compensatory'],['2027-07-28','วันเฉลิมพระชนมพรรษา ร.10','official'],
    ['2027-08-12','วันแม่แห่งชาติ','official'],['2027-10-13','วันนวมินทรมหาราช','official'],['2027-10-25','ชดเชยวันปิยมหาราช (23 ต.ค.)','compensatory'],
    ['2027-12-06','ชดเชยวันพ่อแห่งชาติ (5 ธ.ค.)','compensatory'],['2027-12-10','วันรัฐธรรมนูญ','official'],['2027-12-31','วันสิ้นปี','official'],
  ],
};
const BANK_SOURCE = { 2026: 'ประกาศ ธปท. ที่ 31/2568', 2027: 'ประกาศ ธปท. ที่ 37/2569' };
function applyBankHolidays(year) {
  const list = BANK_HOLIDAYS[year]; if (!list) return 0;
  let n = 0;
  list.forEach(([date, name, type]) => {
    const ex = store.holidays.find(h => h.date === date);
    if (ex) { ex.name = name; ex.type = type; ex.source = 'bank'; if (ex.active === undefined) ex.active = true; }
    else { store.holidays.push({ id: genId('holidays'), date, name, name_en: '', type, year, active: true, source: 'bank' }); n++; }
  });
  return n;
}
function seedHolidays() {
  store.settings = store.settings || {};
  if ((store.settings.holiday_version || 0) >= 2) return;
  // v2: company follows the bank holiday calendar. Remove the old non-bank seed day (เข้าพรรษา 30 ก.ค. 2569),
  // then load the official 2026 + 2027 lists. Holidays an admin added by hand are kept.
  store.holidays = store.holidays.filter(h => !(h.date === '2026-07-30' && !h.source));
  store.holidays.forEach(h => { if (h.active === undefined) h.active = true; if (!h.source) h.source = 'custom'; });
  const added = applyBankHolidays(2026) + applyBankHolidays(2027);
  store.settings.holiday_version = 2;
  saveDb();
  console.log('Holidays migrated to bank calendar v2 (+' + added + ')');
}

// ══════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'ไฟล์ใหญ่เกินไป' });
  if (err) return res.status(400).json({ error: 'Invalid request body' });
  next();
});
// Strip characters that could inject HTML/JS into the UI (stored XSS). Binary/secret fields are left untouched.
const RAW_KEYS = new Set(['password','currentPassword','newPassword','data','credential']);
function sanitize(v, key) {
  if (typeof v === 'string') return RAW_KEYS.has(key) ? v : v.replace(/[<>"`]/g, '');
  if (Array.isArray(v)) return v.map(x => sanitize(x, key));
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = sanitize(v[k], k); return v; }
  return v;
}
app.use((req, res, next) => { if (req.body && typeof req.body === 'object') sanitize(req.body, ''); next(); });

// Only the web app itself is public — never the server source, scripts or data files.
const PUBLIC_FILES = { '/': 'hris.html', '/hris.html': 'hris.html', '/index.html': 'hris.html', '/config.js': 'config.js' };
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path]));
});

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  let payload;
  try { payload = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
  // Always use the CURRENT role from the database, so role changes/removals apply immediately
  const u = store.users.find(x => x.id === payload.id) || store.users.find(x => x.email === payload.email);
  if (!u) return res.status(401).json({ error: 'User no longer exists' });
  req.user = { id: u.id, email: u.email, role: u.role };
  next();
}
// Simple in-memory login throttle: 10 failed attempts per email+IP per 15 minutes
const loginFails = new Map();
function loginKey(req, email) { return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() + '|' + email; }
function tooManyFails(key) {
  const e = loginFails.get(key);
  if (!e) return false;
  if (Date.now() - e.first > 15*60*1000) { loginFails.delete(key); return false; }
  return e.count >= 10;
}
function recordFail(key) {
  const e = loginFails.get(key);
  if (!e || Date.now() - e.first > 15*60*1000) loginFails.set(key, { count: 1, first: Date.now() });
  else e.count++;
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}
// Saved page permissions, falling back to the role defaults when missing or corrupt
function permsOf(u) {
  let p = u.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  return Array.isArray(p) && p.length ? p : (ROLE_DEFAULTS[u.role] || ROLE_DEFAULTS.employee);
}
function fmtUser(u) {
  const emp = store.employees.find(e => e.user_id === u.id);
  return { id:u.id, name:u.name, email:u.email, role:u.role,
    permissions: permsOf(u),
    department:u.department||'', position:u.position||'', phone:u.phone||'',
    color:u.color||'#6B7280', init:u.init||'?',
    picture:u.picture||'', auth_provider:u.auth_provider||'local',
    dob:u.dob||'', nationality:u.nationality||'', id_card:u.id_card||'',
    name_th:u.name_th||'', name_en:u.name_en||'',
    bank_name:u.bank_name||'', bank_account:u.bank_account||'', bank_holder:u.bank_holder||'',
    // From employee record (admin-managed)
    emp_id: emp ? emp.emp_id : '',
    start_date: emp ? (emp.start_date||'') : '',
    contract_type: emp ? (emp.contract_type||'') : '',
    work_type: emp ? (emp.work_type||emp.work_model||'') : '',
  };
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const em = String(email).toLowerCase().trim();
  const key = loginKey(req, em);
  if (tooManyFails(key)) return res.status(429).json({ error: 'ลองเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 15 นาที' });
  const user = store.users.find(u => u.email === em);
  if (!user || !user.password || !bcrypt.compareSync(String(password), user.password)) {
    recordFail(key);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  loginFails.delete(key);
  const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.json({ token, user: fmtUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  let { firstName, lastName, email, password, department, position, phone } = req.body;
  firstName = String(firstName||'').trim(); lastName = String(lastName||'').trim();
  email = String(email||'').toLowerCase().trim();
  if (!firstName || !lastName || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
  if (!RE_EMAIL.test(email)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (store.users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered' });
  const name   = firstName + ' ' + lastName;
  const init   = (firstName[0] + (lastName[0]||'')).toUpperCase();
  const colors = ['#3B82F6','#8B5CF6','#F59E0B','#EF4444','#10B981','#06B6D4'];
  const color  = colors[Math.floor(Math.random() * colors.length)];
  const role   = store.users.length === 0 ? 'admin' : 'employee';
  const perms  = ROLE_DEFAULTS[role];
  const hash   = bcrypt.hashSync(password, 10);
  const newUser = {
    id: genId('users'), name, email: email.toLowerCase(), password: hash,
    role, permissions: JSON.stringify(perms), department: department||'',
    position: position||'', phone: phone||'', color, init,
    google_id:'', auth_provider:'local', picture:'',
    created_at: new Date().toISOString()
  };
  store.users.push(newUser);
  const empId = nextEmpId();
  store.employees.push({
    id: genId('employees'), emp_id: empId, user_id: newUser.id,
    name, email, department: department||'', position: position||'',
    join_date: bkkToday(), status:'Active', work_model:'Office',
    phone: phone||'', color, init, created_at: new Date().toISOString()
  });
  saveDb();
  const token = jwt.sign({ id:newUser.id, email:newUser.email, role:newUser.role }, JWT_SECRET, { expiresIn:'7d' });
  res.status(201).json({ token, user: fmtUser(newUser) });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google login not configured on this server' });
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });
  try {
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    let user = store.users.find(u => u.email === email.toLowerCase());
    if (!user) {
      const nameParts = (name||'User').split(' ');
      const init  = nameParts.map(p=>p[0]).slice(0,2).join('').toUpperCase() || 'U';
      const colors= ['#3B82F6','#8B5CF6','#F59E0B','#EF4444','#10B981','#06B6D4'];
      const color = colors[Math.floor(Math.random()*colors.length)];
      const role  = store.users.length === 0 ? 'admin' : 'employee';
      const perms = ROLE_DEFAULTS[role];
      const newUser = {
        id: genId('users'), name, email: email.toLowerCase(), password:'',
        role, permissions: JSON.stringify(perms), department:'', position:'',
        phone:'', color, init, google_id: googleId, auth_provider:'google',
        picture: picture||'', created_at: new Date().toISOString()
      };
      store.users.push(newUser);
      const empId = nextEmpId();
      store.employees.push({
        id: genId('employees'), emp_id: empId, user_id: newUser.id,
        name, email: email.toLowerCase(), department:'', position:'',
        join_date: bkkToday(), status:'Active', work_model:'Office',
        phone:'', color, init, created_at: new Date().toISOString()
      });
      saveDb();
      user = newUser;
    } else if (!user.google_id) {
      user.google_id = googleId; user.auth_provider = 'google'; user.picture = picture||'';
      saveDb();
    }
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, user: fmtUser(user) });
  } catch(err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// Forgot password: never resets anything by itself — it notifies admins, who reset it from the Permissions page.
// Always answers the same way so it can't be used to discover which emails exist.
app.post('/api/auth/forgot-password', (req, res) => {
  const em = String(req.body.email||'').toLowerCase().trim();
  const user = store.users.find(u => u.email === em);
  if (user) {
    store.users.filter(u => u.role === 'admin').forEach(a => notify(user.id, a.id,
      `🔑 คำขอรีเซ็ตรหัสผ่าน — ${user.name}`,
      `${user.name} (${user.email}) ขอรีเซ็ตรหัสผ่าน\nไปที่หน้า "สิทธิ์การใช้งาน" → แก้ไขผู้ใช้ → รีเซ็ตรหัสผ่าน`));
    saveDb();
  }
  res.json({ ok: true, message: 'ส่งคำขอถึงผู้ดูแลระบบแล้ว' });
});
// Change own password
app.put('/api/auth/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = store.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
  if (user.password && !bcrypt.compareSync(String(currentPassword||''), user.password)) return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  user.password = bcrypt.hashSync(String(newPassword), 10);
  saveDb(); res.json({ ok: true });
});
// Admin: reset another user's password to a random temporary one (shown once to the admin)
app.put('/api/users/:id/password', auth, requireRole('admin'), (req, res) => {
  const user = store.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const temp = require('crypto').randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8) + '9a';
  user.password = bcrypt.hashSync(temp, 10);
  for (const k of loginFails.keys()) if (k.endsWith('|' + user.email)) loginFails.delete(k); // unlock the account
  notify(req.user.id, user.id, '🔑 รหัสผ่านของคุณถูกรีเซ็ต', 'ผู้ดูแลระบบได้รีเซ็ตรหัสผ่านของคุณ กรุณาเปลี่ยนรหัสผ่านหลังเข้าสู่ระบบ');
  saveDb(); res.json({ ok: true, tempPassword: temp });
});

app.get('/api/auth/me', auth, (req, res) => {
  // Fallback to email lookup — handles stale token id after DB reset
  const user = store.users.find(u => u.id === req.user.id)
            || store.users.find(u => u.email === req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(fmtUser(user));
});

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
app.get('/api/employees', auth, (req, res) => {
  res.json([...store.employees].sort((a,b) => (a.name||'').localeCompare(b.name||'')));
});
app.post('/api/employees', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { name, email, department, position, join_date, work_model, phone, color, init } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อพนักงาน' });
  const empId = nextEmpId();
  const emp = {
    id: genId('employees'), emp_id: empId, user_id: null,
    name, email: email||'', department: department||'', position: position||'',
    join_date: join_date||bkkToday(), status:'Active',
    work_model: work_model||'Office', phone: phone||'',
    color: color||'#6B7280', init: init||'?', created_at: new Date().toISOString()
  };
  store.employees.push(emp);
  saveDb();
  res.status(201).json({ id: emp.id, emp_id: empId });
});
app.put('/api/employees/:id', auth, requireRole('admin','hr_manager'), (req, res) => {
  const emp = store.employees.find(e => e.id == req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const { name, department, position, status, work_model, phone } = req.body;
  Object.assign(emp, { name, department, position, status, work_model, phone });
  saveDb(); res.json({ ok: true });
});
app.put('/api/employees/:id/quota', auth, requireRole('admin','hr_manager'), (req, res) => {
  const emp = store.employees.find(e => e.id == req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const { annual_bonus, sick_bonus, casual_bonus, comp_bonus } = req.body;
  if (annual_bonus !== undefined) emp.annual_bonus = +annual_bonus || 0;
  if (sick_bonus   !== undefined) emp.sick_bonus   = +sick_bonus   || 0;
  if (casual_bonus !== undefined) emp.casual_bonus = +casual_bonus || 0;
  if (comp_bonus   !== undefined) emp.comp_bonus   = +comp_bonus   || 0;
  saveDb(); res.json({ ok: true });
});
app.delete('/api/employees/:id', auth, requireRole('admin'), (req, res) => {
  store.employees = store.employees.filter(e => e.id != req.params.id);
  saveDb(); res.json({ ok: true });
});

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
app.get('/api/attendance', auth, (req, res) => {
  const { userId, month } = req.query;
  const targetId = Number(userId || req.user.id);
  if (targetId !== req.user.id && !['admin','hr_manager','hr_staff'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });
  let rows = store.attendance.filter(a => a.user_id === targetId);
  if (month) rows = rows.filter(a => a.date && a.date.startsWith(month));
  res.json([...rows].sort((a,b) => b.date.localeCompare(a.date)));
});
app.get('/api/attendance/today', auth, (req, res) => {
  const today = bkkToday();
  res.json(store.attendance.find(a => a.user_id === req.user.id && a.date === today) || null);
});
app.post('/api/attendance/checkin', auth, (req, res) => {
  const today = bkkToday();
  const now   = bkkNowHHMM();
  const { location, note } = req.body;
  const existing = store.attendance.find(a => a.user_id === req.user.id && a.date === today);
  if (existing && existing.check_in) return res.status(409).json({ error: 'Already checked in today' });
  if (existing) {
    existing.check_in = now; existing.location = location||'Office'; existing.note = note||'';
  } else {
    store.attendance.push({
      id: genId('attendance'), user_id: req.user.id, date: today,
      check_in: now, check_out: null, work_hours: null,
      location: location||'Office', note: note||'', status:'Present',
      is_retroactive: 0, retro_status:'Approved', retro_reason:'', retro_approved_by: null,
      created_at: new Date().toISOString()
    });
  }
  saveDb(); res.json({ check_in: now, date: today });
});
app.post('/api/attendance/checkout', auth, (req, res) => {
  const today = bkkToday();
  const now   = bkkNowHHMM();
  const row   = store.attendance.find(a => a.user_id === req.user.id && a.date === today);
  if (!row || !row.check_in) return res.status(400).json({ error: 'Not checked in yet' });
  if (row.check_out) return res.status(409).json({ error: 'Already checked out today' });
  const mins = Math.max(0, toMin(now) - toMin(row.check_in));
  row.check_out   = now;
  row.work_hours  = fmtDur(mins);
  saveDb(); res.json({ check_out: now, work_hours: row.work_hours });
});

// RETROACTIVE ATTENDANCE
app.post('/api/attendance/retroactive', auth, (req, res) => {
  const { date, check_in, check_out, location, reason } = req.body;
  if (!date || !check_in) return res.status(400).json({ error: 'Date and check-in time required' });
  if (!isDate(date)) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
  if (!RE_TIME.test(check_in) || (check_out && !RE_TIME.test(check_out))) return res.status(400).json({ error: 'รูปแบบเวลาไม่ถูกต้อง (HH:MM)' });
  const today = bkkToday();
  if (date >= today) return res.status(400).json({ error: 'Can only submit retroactive for past dates' });
  let workHours = null;
  if (check_out) {
    const mins = toMin(check_out) - toMin(check_in);
    if (mins <= 0) return res.status(400).json({ error: 'เวลาออกต้องหลังเวลาเข้า' });
    workHours = fmtDur(mins);
  }
  if (store.attendance.find(a => a.user_id === req.user.id && a.date === date))
    return res.status(409).json({ error: 'Attendance record already exists for this date' });
  const row = {
    id: genId('attendance'), user_id: req.user.id, date, check_in, check_out: check_out||null,
    work_hours: workHours, location: location||'Office', note:'', status:'Present',
    is_retroactive: 1, retro_status:'Pending', retro_reason: reason||'', retro_approved_by: null,
    created_at: new Date().toISOString()
  };
  store.attendance.push(row);
  const requester = store.users.find(u => u.id === req.user.id);
  const managers  = store.users.filter(u => ['admin','hr_manager','hr_staff'].includes(u.role));
  managers.forEach(m => store.inbox.push({
    id: genId('inbox'), from_user: req.user.id, to_user: m.id,
    subject: `[รออนุมัติ] บันทึกเวลาย้อนหลัง — ${requester?.name||''}`,
    body: `${requester?.name||''} ขอบันทึกเวลาย้อนหลังวันที่ ${date}\nเหตุผล: ${reason||'-'}`,
    is_read: 0, created_at: new Date().toISOString()
  }));
  saveDb();
  res.status(201).json({ id: row.id, retro_status:'Pending' });
});
app.get('/api/attendance/retroactive', auth, (req, res) => {
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let rows = store.attendance.filter(a => a.is_retroactive === 1 || a.is_retroactive === true);
  if (!isManager) rows = rows.filter(a => a.user_id === req.user.id);
  else if (req.query.pending) rows = rows.filter(a => a.retro_status === 'Pending');
  const result = rows.map(a => {
    const u  = store.users.find(x => x.id === a.user_id) || {};
    const ap = store.users.find(x => x.id === a.retro_approved_by) || {};
    return { ...a, emp_name: u.name||'', emp_init: u.init||'?', emp_color: u.color||'#6B7280', approver_name: ap.name||'' };
  });
  res.json([...result].sort((a,b) => b.date.localeCompare(a.date)));
});
app.put('/api/attendance/retroactive/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { status, note } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const row = store.attendance.find(a => a.id == req.params.id && (a.is_retroactive === 1 || a.is_retroactive === true));
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.retro_status = status; row.retro_approved_by = req.user.id;
  const approver = store.users.find(u => u.id === req.user.id);
  const emoji = status === 'Approved' ? '✅' : '❌';
  store.inbox.push({
    id: genId('inbox'), from_user: req.user.id, to_user: row.user_id,
    subject: `${emoji} บันทึกเวลาย้อนหลังวันที่ ${row.date} — ${status}`,
    body: `${approver?.name||''} ${status==='Approved'?'อนุมัติ':'ไม่อนุมัติ'}การบันทึกเวลาย้อนหลังของคุณวันที่ ${row.date}${note?'\nหมายเหตุ: '+note:''}`,
    is_read: 0, created_at: new Date().toISOString()
  });
  saveDb();
  res.json({ ok: true, status });
});

// ── LEAVE ─────────────────────────────────────────────────────────────────────
app.get('/api/leave', auth, (req, res) => {
  const { scope } = req.query;
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let rows = scope === 'pending' && isManager
    ? store.leave_requests.filter(r => r.status === 'Pending')
    : scope === 'team' && isManager
    ? [...store.leave_requests]
    : store.leave_requests.filter(r => r.user_id === req.user.id);
  const result = rows.map(r => {
    const u  = store.users.find(x => x.id === r.user_id) || {};
    const ap = store.users.find(x => x.id === r.approved_by) || {};
    return { ...r, emp_name: u.name||'', emp_init: u.init||'?', emp_color: u.color||'#6B7280', approver_name: ap.name||'' };
  });
  res.json([...result].sort((a,b) => b.created_at.localeCompare(a.created_at)));
});
const LEAVE_TYPES = ['Annual','Sick','Casual','Compensatory','Comp'];
const LEAVE_TH = { Annual:'ลาพักร้อน', Sick:'ลาป่วย', Casual:'ลากิจ', Compensatory:'ลาชดเชย', Comp:'ขอวันลาชดเชย' };
// ── Leave attachments (medical certificates) — stored separately from main store ──
const ATT_ALLOWED = ['image/jpeg','image/png','image/webp','image/heic','application/pdf'];
const ATT_MAX_BYTES = 5 * 1024 * 1024;
async function saveAttachment(leaveId, att) {
  const json = JSON.stringify(att);
  if (pgPool) {
    await pgPool.query(
      "INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      ['leave_att_' + leaveId, json]
    );
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'leave_att_' + leaveId + '.json'), json);
}
async function loadAttachment(leaveId) {
  if (pgPool) {
    const r = await pgPool.query("SELECT value FROM kv WHERE key=$1", ['leave_att_' + leaveId]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  }
  const f = path.join(DATA_DIR, 'leave_att_' + leaveId + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

app.post('/api/leave', auth, async (req, res) => {
  const { type, from_date, to_date, days, reason, attachment } = req.body;
  if (!type || !from_date || !to_date) return res.status(400).json({ error: 'Missing fields' });
  if (!LEAVE_TYPES.includes(type)) return res.status(400).json({ error: 'ประเภทการลาไม่ถูกต้อง' });
  if (!isDate(from_date) || !isDate(to_date)) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
  if (to_date < from_date) return res.status(400).json({ error: 'วันที่สิ้นสุดต้องไม่ก่อนวันเริ่มต้น' });
  const reqDays = days === undefined ? 1 : Number(days);
  const span = Math.round((new Date(to_date) - new Date(from_date)) / 864e5) + 1;
  if (!isFinite(reqDays) || reqDays < 0.5 || reqDays > span || reqDays > 365) return res.status(400).json({ error: 'จำนวนวันลาไม่ถูกต้อง' });
  // Time off counts working days only (no weekends / company holidays). 'Comp' rows record holiday work, so keep their count.
  let nDays = reqDays;
  if (type !== 'Comp') {
    const wdays = workingDays(from_date, to_date);
    if (wdays === 0) return res.status(400).json({ error: 'ช่วงวันที่เลือกเป็นวันหยุดทั้งหมด ไม่ต้องยื่นลา' });
    nDays = (reqDays === 0.5 && from_date === to_date) ? 0.5 : wdays;
  }
  // 'Comp' rows record OT-holiday work that EARNS comp days — they aren't time off, so skip the overlap rule
  if (type !== 'Comp') {
    const clash = store.leave_requests.find(r => r.user_id === req.user.id && r.type !== 'Comp'
      && ['Pending','Approved'].includes(r.status) && r.from_date <= to_date && r.to_date >= from_date);
    if (clash) return res.status(409).json({ error: `มีคำขอลาช่วง ${clash.from_date} – ${clash.to_date} อยู่แล้ว` });
  }
  // Validate attachment if present
  let att = null;
  if (attachment && attachment.data) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(attachment.data);
    if (!m) return res.status(400).json({ error: 'ไฟล์แนบไม่ถูกต้อง' });
    const mime = m[1];
    if (!ATT_ALLOWED.includes(mime)) return res.status(400).json({ error: 'รองรับเฉพาะรูปภาพ (JPG/PNG) หรือ PDF' });
    const bytes = Math.floor(m[2].length * 3 / 4);
    if (bytes > ATT_MAX_BYTES) return res.status(400).json({ error: 'ไฟล์ใหญ่เกิน 5 MB' });
    att = { name: String(attachment.name || 'medical-certificate').slice(0, 120), type: mime, data: attachment.data };
  }
  const row = {
    id: genId('leave_requests'), user_id: req.user.id, type, from_date, to_date,
    days: nDays, reason: reason||'', status:'Pending',
    approved_by: null, note:'', created_at: new Date().toISOString(),
    has_attachment: !!att, attachment_name: att ? att.name : ''
  };
  if (att) {
    try { await saveAttachment(row.id, att); }
    catch (e) { console.error('Attachment save error:', e.message); return res.status(500).json({ error: 'บันทึกไฟล์แนบไม่สำเร็จ' }); }
  }
  store.leave_requests.push(row);
  saveDb(); res.status(201).json({ id: row.id });
});
app.get('/api/leave/:id/attachment', auth, async (req, res) => {
  const row = store.leave_requests.find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  if (!isManager && row.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const att = await loadAttachment(row.id);
    if (!att) return res.status(404).json({ error: 'ไม่พบไฟล์แนบ' });
    res.json(att);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/leave/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const row = store.leave_requests.find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!canDecide(req.user.role, row.type === 'Comp' || row.type === 'Compensatory' ? 'comp' : 'leave'))
    return res.status(403).json({ error: 'คุณไม่มีสิทธิ์อนุมัติคำขอประเภทนี้ (ตั้งค่าที่ลำดับการอนุมัติ)' });
  if (row.status === 'Cancelled') return res.status(409).json({ error: 'คำขอนี้ถูกยกเลิกแล้ว' });
  row.status = status; row.approved_by = req.user.id; row.note = note||''; row.decided_at = new Date().toISOString();
  const ok = status === 'Approved';
  notify(req.user.id, row.user_id,
    `${ok?'✅':'❌'} คำขอ${LEAVE_TH[row.type]||'ลา'} ${row.from_date}${row.to_date!==row.from_date?' – '+row.to_date:''} — ${ok?'อนุมัติ':'ไม่อนุมัติ'}`,
    `${(store.users.find(u=>u.id===req.user.id)||{}).name||''} ${ok?'อนุมัติ':'ไม่อนุมัติ'}คำขอของคุณ (${row.days} วัน)${note?'\nหมายเหตุ: '+note:''}`);
  saveDb(); res.json({ ok: true });
});
// Cancel a leave request — owner (pending, or approved leave that hasn't started) or a manager
app.put('/api/leave/:id/cancel', auth, (req, res) => {
  const row = store.leave_requests.find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const mgr = isManagerRole(req.user.role);
  if (row.user_id !== req.user.id && !mgr) return res.status(403).json({ error: 'Forbidden' });
  if (row.status === 'Cancelled' || row.status === 'Rejected') return res.status(409).json({ error: 'คำขอนี้ปิดไปแล้ว' });
  if (!mgr && row.status === 'Approved' && row.from_date <= bkkToday())
    return res.status(409).json({ error: 'วันลาเริ่มไปแล้ว — กรุณาติดต่อ HR เพื่อยกเลิก' });
  const wasApproved = row.status === 'Approved';
  row.status = 'Cancelled'; row.cancelled_by = req.user.id; row.cancelled_at = new Date().toISOString();
  if (wasApproved && row.user_id === req.user.id) {
    const me = store.users.find(u => u.id === req.user.id) || {};
    store.users.filter(u => isManagerRole(u.role) && u.id !== req.user.id).forEach(m =>
      notify(req.user.id, m.id, `↩️ ยกเลิก${LEAVE_TH[row.type]||'ลา'} — ${me.name||''}`, `${me.name||''} ยกเลิกวันลาที่อนุมัติแล้ว ${row.from_date} – ${row.to_date}`));
  }
  saveDb(); res.json({ ok: true });
});

// ── OT ────────────────────────────────────────────────────────────────────────
app.get('/api/ot', auth, (req, res) => {
  const { scope } = req.query;
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let rows = scope === 'pending' && isManager
    ? store.ot_requests.filter(r => r.status === 'Pending')
    : scope === 'team' && isManager
    ? [...store.ot_requests]
    : store.ot_requests.filter(r => r.user_id === req.user.id);
  const result = rows.map(r => {
    const u  = store.users.find(x => x.id === r.user_id) || {};
    const ap = store.users.find(x => x.id === r.approved_by) || {};
    return { ...r, emp_name: u.name||'', emp_init: u.init||'?', emp_color: u.color||'#6B7280', approver_name: ap.name||'' };
  });
  res.json([...result].sort((a,b) => b.created_at.localeCompare(a.created_at)));
});
app.post('/api/ot', auth, (req, res) => {
  const { date, start_time, end_time, hours, type, reason } = req.body;
  if (!date || !start_time || !end_time || !reason) return res.status(400).json({ error: 'Missing fields' });
  if (!isDate(date)) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
  if (!RE_TIME.test(start_time) || !RE_TIME.test(end_time)) return res.status(400).json({ error: 'รูปแบบเวลาไม่ถูกต้อง (HH:MM)' });
  if (toMin(end_time) <= toMin(start_time)) return res.status(400).json({ error: 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม' });
  const row = {
    id: genId('ot_requests'), user_id: req.user.id, date, start_time, end_time,
    hours: hours||'', type: type||'Voluntary', reason,
    status:'Pending', approved_by: null, note:'', created_at: new Date().toISOString()
  };
  store.ot_requests.push(row);
  saveDb(); res.status(201).json({ id: row.id });
});
app.put('/api/ot/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const row = store.ot_requests.find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!canDecide(req.user.role, 'ot')) return res.status(403).json({ error: 'คุณไม่มีสิทธิ์อนุมัติ OT (ตั้งค่าที่ลำดับการอนุมัติ)' });
  row.status = status; row.approved_by = req.user.id; row.note = note||'';
  const ok = status === 'Approved';
  notify(req.user.id, row.user_id, `${ok?'✅':'❌'} คำขอ OT ${row.date} — ${ok?'อนุมัติ':'ไม่อนุมัติ'}`,
    `${row.start_time}–${row.end_time}${note?'\nหมายเหตุ: '+note:''}`);
  saveDb(); res.json({ ok: true });
});

// ── INBOX ─────────────────────────────────────────────────────────────────────
app.get('/api/inbox', auth, (req, res) => {
  const rows = store.inbox
    .filter(i => i.to_user === req.user.id)
    .map(i => {
      const u = store.users.find(x => x.id === i.from_user) || {};
      return { ...i, from_name: u.name||'', from_init: u.init||'?', from_color: u.color||'#6B7280' };
    });
  res.json([...rows].sort((a,b) => b.created_at.localeCompare(a.created_at)));
});
app.post('/api/inbox', auth, (req, res) => {
  const { to_user, subject, body } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject required' });
  if (!to_user || !store.users.find(u => u.id == to_user)) return res.status(400).json({ error: 'กรุณาเลือกผู้รับ' });
  const row = {
    id: genId('inbox'), from_user: req.user.id, to_user: Number(to_user),
    subject, body: body||'', is_read: 0, created_at: new Date().toISOString()
  };
  store.inbox.push(row);
  saveDb(); res.status(201).json({ id: row.id });
});
app.put('/api/inbox/:id/read', auth, (req, res) => {
  const row = store.inbox.find(i => i.id == req.params.id && i.to_user === req.user.id);
  if (row) { row.is_read = 1; saveDb(); }
  res.json({ ok: true });
});

// ── APPOINTMENTS ──────────────────────────────────────────────────────────────
app.get('/api/appointments', auth, (req, res) => {
  const { month } = req.query;
  let rows = store.appointments.filter(a => a.user_id === req.user.id);
  if (month) rows = rows.filter(a => a.date && a.date.startsWith(month));
  res.json([...rows].sort((a,b) => (a.date+a.start_time).localeCompare(b.date+b.start_time)));
});
app.post('/api/appointments', auth, (req, res) => {
  const { title, date, start_time, end_time, type, location, participants, notes } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'Title and date required' });
  const row = {
    id: genId('appointments'), user_id: req.user.id, title, date,
    start_time: start_time||'', end_time: end_time||'', type: type||'meeting',
    location: location||'', participants: participants||'', notes: notes||'',
    created_at: new Date().toISOString()
  };
  store.appointments.push(row);
  saveDb(); res.status(201).json({ id: row.id });
});
app.delete('/api/appointments/:id', auth, (req, res) => {
  store.appointments = store.appointments.filter(a => !(a.id == req.params.id && a.user_id === req.user.id));
  saveDb(); res.json({ ok: true });
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, requireRole('admin','hr_manager'), (req, res) => {
  res.json(store.users.map(u => ({
    id:u.id, name:u.name, email:u.email, role:u.role,
    permissions: permsOf(u),
    department:u.department||'', position:u.position||'',
    color:u.color||'#6B7280', init:u.init||'?', created_at:u.created_at
  })).sort((a,b) => (a.name||'').localeCompare(b.name||'')));
});
app.put('/api/users/:id/profile', auth, (req, res) => {
  if (req.user.id != req.params.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  // Find by id; fallback to email (handles stale token after DB reset)
  let user = store.users.find(u => u.id == req.params.id);
  if (!user) user = store.users.find(u => u.email === req.user.email);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { name, department, position, phone, dob, nationality, id_card, start_date, contract_type, work_type } = req.body;
  if (name)                    user.name        = name;
  if (department !== undefined) user.department = department;
  if (position   !== undefined) user.position   = position;
  if (phone      !== undefined) user.phone       = phone;
  if (dob        !== undefined) user.dob         = dob;
  if (nationality!== undefined) user.nationality = nationality;
  if (id_card    !== undefined) user.id_card     = id_card;
  // Update init from name
  if (name) {
    const parts = name.trim().split(/\s+/);
    user.init = parts.length > 1
      ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
      : (parts[0].slice(0,2)).toUpperCase();
  }
  // Sync employee record too (including employment fields from cache restore)
  const emp = store.employees.find(e => e.user_id === user.id);
  if (emp) {
    if (name)                    { emp.name = name; emp.init = user.init; }
    if (department !== undefined) emp.department   = department;
    if (position   !== undefined) emp.position     = position;
    if (phone      !== undefined) emp.phone        = phone;
    // Employment fields drive leave quota & probation — only admin / HR manager may set them
    if (['admin','hr_manager'].includes(req.user.role)) {
      if (start_date    !== undefined && start_date    !== '') emp.start_date    = start_date;
      if (contract_type !== undefined && contract_type !== '') emp.contract_type = contract_type;
      if (work_type     !== undefined && work_type     !== '') emp.work_type     = work_type;
    }
  }
  saveDb();
  res.json(fmtUser(user));
});

// Admin-only: set employment fields (start_date, contract_type, work_type)
app.put('/api/users/:id/employment', auth, requireRole('admin','hr_manager'), (req, res) => {
  const user = store.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const emp = store.employees.find(e => e.user_id === user.id);
  if (!emp) return res.status(404).json({ error: 'Employee record not found' });
  const { start_date, contract_type, work_type } = req.body;
  if (start_date    !== undefined) emp.start_date    = start_date;
  if (contract_type !== undefined) emp.contract_type = contract_type;
  if (work_type     !== undefined) emp.work_type     = work_type;
  saveDb();
  res.json(fmtUser(user));
});

app.put('/api/users/:id/permissions', auth, requireRole('admin'), (req, res) => {
  const user = store.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { role, permissions } = req.body;
  if (!ROLE_DEFAULTS[role]) return res.status(400).json({ error: 'Invalid role' });
  if (!Array.isArray(permissions) || permissions.some(p => typeof p !== 'string')) return res.status(400).json({ error: 'Invalid permissions' });
  if (user.role === 'admin' && role !== 'admin' && store.users.filter(u => u.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'ต้องมีผู้ดูแลระบบ (Admin) อย่างน้อย 1 คน' });
  user.role = role; user.permissions = JSON.stringify(permissions);
  saveDb(); res.json({ ok: true });
});
// Admin / HR manager creates an account (user + employee record). Without a password, a temporary one is generated.
app.post('/api/users', auth, requireRole('admin','hr_manager'), (req, res) => {
  let { name, firstName, lastName, email, password, role, department, position, phone, start_date, contract_type, work_type } = req.body;
  name = String(name || [firstName, lastName].filter(Boolean).join(' ')).trim();
  email = String(email||'').toLowerCase().trim();
  role = role || 'employee';
  if (!name) return res.status(400).json({ error: 'กรุณาระบุชื่อ' });
  if (!RE_EMAIL.test(email)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });
  if (!ROLE_DEFAULTS[role]) return res.status(400).json({ error: 'Invalid role' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'เฉพาะ Admin เท่านั้นที่สร้างบัญชี Admin ได้' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (store.users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered' });
  const temp = password ? null : require('crypto').randomBytes(6).toString('base64').replace(/[+/=]/g,'').slice(0,8) + '9a';
  const parts = name.split(/\s+/);
  const init = (parts.length > 1 ? parts[0][0] + parts[parts.length-1][0] : name.slice(0,2)).toUpperCase();
  const colors = ['#3B82F6','#8B5CF6','#F59E0B','#EF4444','#10B981','#06B6D4'];
  const color = colors[store.users.length % colors.length];
  const u = { id: genId('users'), name, email, password: bcrypt.hashSync(String(password || temp), 10), role,
    permissions: JSON.stringify(ROLE_DEFAULTS[role]), department: department||'', position: position||'', phone: phone||'',
    color, init, google_id:'', auth_provider:'local', picture:'', created_at: new Date().toISOString() };
  store.users.push(u);
  store.employees.push({ id: genId('employees'), emp_id: nextEmpId(), user_id: u.id, name, email,
    department: department||'', position: position||'', join_date: start_date && isDate(start_date) ? start_date : bkkToday(),
    start_date: start_date && isDate(start_date) ? start_date : undefined, contract_type: contract_type||undefined,
    status:'Active', work_model: work_type||'Office', work_type: work_type||undefined, phone: phone||'', color, init, created_at: new Date().toISOString() });
  saveDb();
  res.status(201).json({ ok: true, user: fmtUser(u), tempPassword: temp });
});
// Company directory for messaging — every signed-in user (no contact or personal data)
app.get('/api/directory', auth, (req, res) => {
  res.json(store.users.map(u => ({ id: u.id, name: u.name, init: u.init||'?', color: u.color||'#6B7280', department: u.department||'', position: u.position||'' }))
    .sort((a,b) => (a.name||'').localeCompare(b.name||'')));
});
// Settings (approval chain)
app.get('/api/settings', auth, (req, res) => res.json({ approval_chain: approvalChain(), workdays: workdaysSetting() }));
app.put('/api/settings', auth, requireRole('admin'), (req, res) => {
  const c = req.body.approval_chain || {};
  for (const k of ['leave','ot','comp']) if (c[k] !== undefined && !ROLE_RANK[c[k]]) return res.status(400).json({ error: 'Invalid role for ' + k });
  const wd = req.body.workdays;
  if (wd !== undefined && (!Array.isArray(wd) || !wd.length || wd.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return res.status(400).json({ error: 'วันทำงานไม่ถูกต้อง' });
  store.settings = store.settings || {};
  if (req.body.approval_chain) store.settings.approval_chain = { ...approvalChain(), ...c };
  if (wd !== undefined) store.settings.workdays = [...new Set(wd)].sort();
  saveDb(); res.json({ ok: true, approval_chain: approvalChain(), workdays: workdaysSetting() });
});
// Full data export for backups (admin). Password hashes are never included.
app.get('/api/export', auth, requireRole('admin'), (req, res) => {
  const data = {};
  STORE_KEYS.forEach(k => { data[k] = store[k]; });
  data.users = store.users.map(({ password, ...rest }) => rest);
  res.set('Content-Disposition', `attachment; filename="teams-hris-backup-${bkkToday()}.json"`);
  res.json({ exported_at: new Date().toISOString(), version: 2, data });
});

// Approver list for request forms — available to every signed-in user (names & roles only)
app.get('/api/approvers', auth, (req, res) => {
  let list = store.users.filter(u => isManagerRole(u.role) && u.id !== req.user.id);
  if (!list.length) list = store.users.filter(u => isManagerRole(u.role)); // sole manager may self-approve
  res.json(list.map(u => ({ id: u.id, name: u.name, role: u.role })).sort((a,b) => (a.name||'').localeCompare(b.name||'')));
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const today = bkkToday();
  res.json({
    totalEmployees: store.employees.length,
    presentToday:   store.attendance.filter(a => a.date === today && a.check_in).length,
    pendingLeave:   store.leave_requests.filter(r => r.status === 'Pending').length,
    pendingOT:      store.ot_requests.filter(r => r.status === 'Pending').length,
    onLeaveToday:   new Set(store.leave_requests.filter(r => r.status === 'Approved' && r.type !== 'Comp' && r.from_date <= today && r.to_date >= today).map(r => r.user_id)).size,
  });
});

// ── HOLIDAYS ──────────────────────────────────────────────────────────────────
// Holidays. Default list = holidays the company observes (active). Admin/HR can ask for ?all=1 to manage inactive ones too.
function isHolidayManager(req) {
  const h = req.headers.authorization; if (!h) return false;
  try { const p = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET); const u = store.users.find(x => x.id === p.id); return !!u && ['admin','hr_manager'].includes(u.role); } catch { return false; }
}
app.get('/api/holidays', (req, res) => {
  const { year, month, all } = req.query;
  let rows = [...store.holidays];
  if (!(all && isHolidayManager(req))) rows = rows.filter(h => h.active !== false);
  if (year)  rows = rows.filter(h => h.year === Number(year));
  if (month) rows = rows.filter(h => h.date && h.date.startsWith(`${year||''}-${String(month).padStart(2,'0')}-`));
  res.json([...rows].sort((a,b) => a.date.localeCompare(b.date)));
});
app.get('/api/holidays/presets', auth, (req, res) => {
  res.json(Object.keys(BANK_HOLIDAYS).map(y => ({ year: +y, count: BANK_HOLIDAYS[y].length, source: BANK_SOURCE[y] })));
});
app.post('/api/holidays/preset', auth, requireRole('admin','hr_manager'), (req, res) => {
  const year = Number(req.body.year);
  if (!BANK_HOLIDAYS[year]) return res.status(404).json({ error: `ยังไม่มีประกาศวันหยุดธนาคารปี ${year} ในระบบ — เพิ่มวันหยุดเองได้` });
  const added = applyBankHolidays(year);
  saveDb(); res.json({ ok: true, added, total: BANK_HOLIDAYS[year].length, source: BANK_SOURCE[year] });
});
app.post('/api/holidays', auth, requireRole('admin','hr_manager'), (req, res) => {
  const { date, name, name_en, type } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  if (!isDate(date)) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
  const year = parseInt(date.slice(0,4));
  const existing = store.holidays.find(h => h.date === date);
  if (existing) { existing.name = name; existing.name_en = name_en||''; existing.type = type||existing.type||'company'; existing.active = true; }
  else store.holidays.push({ id: genId('holidays'), date, name, name_en: name_en||'', type: type||'company', year, active: true, source: 'custom' });
  saveDb(); res.status(201).json({ ok: true });
});
app.put('/api/holidays/:date', auth, requireRole('admin','hr_manager'), (req, res) => {
  const h = store.holidays.find(x => x.date === req.params.date);
  if (!h) return res.status(404).json({ error: 'Not found' });
  if (req.body.active !== undefined) h.active = !!req.body.active;
  if (req.body.name) h.name = String(req.body.name);
  saveDb(); res.json({ ok: true, holiday: h });
});
app.delete('/api/holidays/:date', auth, requireRole('admin','hr_manager'), (req, res) => {
  store.holidays = store.holidays.filter(h => h.date !== req.params.date);
  saveDb(); res.json({ ok: true });
});
// Working days between two dates (inclusive): company workdays minus active holidays
function workdaysSetting() { const w = (store.settings || {}).workdays; return Array.isArray(w) && w.length ? w : [1,2,3,4,5]; }
function workingDays(from, to) {
  const wd = workdaysSetting(), hol = new Set(store.holidays.filter(h => h.active !== false).map(h => h.date));
  let n = 0;
  for (let t = new Date(from + 'T00:00:00Z'); t <= new Date(to + 'T00:00:00Z'); t = new Date(t.getTime() + 864e5)) {
    const ds = t.toISOString().slice(0,10);
    if (wd.includes(t.getUTCDay()) && !hol.has(ds)) n++;
  }
  return n;
}
app.get('/api/working-days', auth, (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'Invalid range' });
  res.json({ from, to, days: workingDays(from, to), workdays: workdaysSetting() });
});

// ── Departments ──────────────────────────────────────────────────────────────
app.get('/api/departments', auth, (req, res) => {
  const depts = store.departments && store.departments.length ? store.departments : DEFAULT_DEPTS;
  res.json(depts);
});
app.put('/api/departments', auth, requireRole('admin','hr_manager'), (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected array' });
  store.departments = list;
  saveDb();
  res.json({ ok: true });
});

// ── Calendar notes (per user) ─────────────────────────────────────────────────
app.get('/api/cal-notes', auth, (req, res) => {
  res.json(store.cal_notes[req.user.id] || {});
});
app.put('/api/cal-notes', auth, (req, res) => {
  if (typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Expected object' });
  store.cal_notes[req.user.id] = req.body;
  saveDb();
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ status:'ok', time: new Date().toISOString(), mode: pgPool ? 'postgresql' : 'json-store' }));

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════

// ── Seed default admin if no users exist (survives Railway restarts) ──────────
function seedAdmin() {
  if (store.users.length > 0) return; // already have users
  const SEED_EMAIL = process.env.ADMIN_EMAIL || 'padungdech.w@gmail.com';
  const SEED_PASS  = process.env.ADMIN_PASS  || 'Admin1234!';
  const SEED_NAME  = process.env.ADMIN_NAME  || 'Padungdech Wongvoraruj';
  const parts = SEED_NAME.trim().split(/\s+/);
  const init  = parts.length > 1
    ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
    : parts[0].slice(0,2).toUpperCase();
  const admin = {
    id: genId('users'), email: SEED_EMAIL, name: SEED_NAME,
    password: bcrypt.hashSync(SEED_PASS, 10),
    role: 'admin', permissions: JSON.stringify(['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','payroll','permissions','myrecords']),
    department: 'Management', position: 'System Admin',
    phone: '', color: '#10B981', init,
    picture: '', auth_provider: 'local', created_at: new Date().toISOString(),
  };
  store.users.push(admin);
  store.employees.push({
    id: genId('employees'), emp_id: 'EMP001', user_id: admin.id,
    name: SEED_NAME, email: SEED_EMAIL, department: 'Management',
    position: 'System Admin', join_date: bkkToday(),
    status: 'Active', work_model: 'Office', phone: '', color: '#10B981', init,
    created_at: new Date().toISOString(),
  });
  saveDb();
  console.log('  Default admin seeded:', SEED_EMAIL);
}
(async () => {
  await loadStore();
  seedHolidays();
  seedAdmin();
  app.listen(PORT, () => {
    console.log('');
    console.log('  Teams HRIS Backend Running' + (pgPool ? ' (PostgreSQL)' : ' (file store)'));
    console.log('  http://localhost:' + PORT);
    console.log('');
  });
})();
