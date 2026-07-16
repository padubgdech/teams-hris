/**
 * Teams HRIS — Backend API Server
 * Node.js + Express + sql.js (pure JavaScript SQLite)
 * Port: 3001  |  start: node server.js
 */

const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');
const { OAuth2Client } = require('google-auth-library');

const PORT             = process.env.PORT || 3001;
const JWT_SECRET       = process.env.JWT_SECRET || 'teams-hris-secret-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';  // ← ใส่ Client ID จาก Google Cloud Console
const googleClient     = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const DATA_DIR   = path.join(__dirname, 'data');
const DB_FILE    = path.join(DATA_DIR, 'hris.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ══════════════════════════════════════
//  DB HELPERS (wrap sql.js API)
// ══════════════════════════════════════
let db;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row  = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row  = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
  const lastId = db.exec('SELECT last_insert_rowid()');
  return { lastInsertRowid: lastId[0]?.values[0][0] ?? null };
}

function dbExec(sql) { db.run(sql); }

// ══════════════════════════════════════
//  SCHEMA
// ══════════════════════════════════════
function initSchema() {
  dbExec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, password TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'employee', permissions TEXT NOT NULL DEFAULT '[]',
    department TEXT DEFAULT '', position TEXT DEFAULT '', phone TEXT DEFAULT '',
    color TEXT DEFAULT '#6B7280', init TEXT DEFAULT '?',
    google_id TEXT DEFAULT '', auth_provider TEXT DEFAULT 'local',
    picture TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Migrate existing DBs
  try { dbExec(`ALTER TABLE users ADD COLUMN google_id TEXT DEFAULT ''`); } catch(e){}
  try { dbExec(`ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'`); } catch(e){}
  try { dbExec(`ALTER TABLE users ADD COLUMN picture TEXT DEFAULT ''`); } catch(e){}
  dbExec(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, user_id INTEGER,
    name TEXT NOT NULL, email TEXT, department TEXT, position TEXT,
    join_date TEXT, status TEXT DEFAULT 'Active', work_model TEXT DEFAULT 'Office',
    phone TEXT, color TEXT DEFAULT '#6B7280', init TEXT DEFAULT '?',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  dbExec(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    date TEXT NOT NULL, check_in TEXT, check_out TEXT, work_hours TEXT,
    location TEXT DEFAULT 'Office', note TEXT DEFAULT '', status TEXT DEFAULT 'Present',
    is_retroactive INTEGER DEFAULT 0,
    retro_status TEXT DEFAULT 'Approved',
    retro_reason TEXT DEFAULT '',
    retro_approved_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Migrate: add retro columns to existing attendance table if missing
  try { dbExec(`ALTER TABLE attendance ADD COLUMN is_retroactive INTEGER DEFAULT 0`); } catch(e){}
  try { dbExec(`ALTER TABLE attendance ADD COLUMN retro_status TEXT DEFAULT 'Approved'`); } catch(e){}
  try { dbExec(`ALTER TABLE attendance ADD COLUMN retro_reason TEXT DEFAULT ''`); } catch(e){}
  try { dbExec(`ALTER TABLE attendance ADD COLUMN retro_approved_by INTEGER`); } catch(e){}
  dbExec(`CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    type TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL,
    days INTEGER NOT NULL DEFAULT 1, reason TEXT, status TEXT DEFAULT 'Pending',
    approved_by INTEGER, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  )`);
  dbExec(`CREATE TABLE IF NOT EXISTS ot_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    hours TEXT, type TEXT DEFAULT 'Voluntary', reason TEXT,
    status TEXT DEFAULT 'Pending', approved_by INTEGER, note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  dbExec(`CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_user INTEGER, to_user INTEGER,
    subject TEXT NOT NULL, body TEXT, is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  dbExec(`CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    title TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT, end_time TEXT,
    type TEXT DEFAULT 'meeting', location TEXT, participants TEXT DEFAULT '',
    notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  )`);
  dbExec(`CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT DEFAULT '',
    type TEXT DEFAULT 'official',
    year INTEGER NOT NULL
  )`);
}

// ══════════════════════════════════════
//  ROLE DEFAULTS
// ══════════════════════════════════════
const ROLE_DEFAULTS = {
  admin:      ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','payroll','recruitment','permissions'],
  hr_manager: ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave','payroll','recruitment'],
  hr_staff:   ['dashboard','checkin','ot','inbox','calendar','employees','attendance','leave'],
  employee:   ['checkin','ot','inbox','calendar','leave'],
};

// Seed holidays separately — runs even if users already exist
function seedHolidays() {
  const count = dbGet('SELECT COUNT(*) as c FROM holidays').c;
  if (count > 0) return;
  console.log('Seeding holidays...');
  const holidays2026 = [
    ['2026-01-01','วันขึ้นปีใหม่','New Year\'s Day','official'],
    ['2026-01-02','วันหยุดพิเศษ (ครม.)','Special Holiday','special'],
    ['2026-04-06','วันจักรี','Chakri Memorial Day','official'],
    ['2026-04-13','วันสงกรานต์','Songkran Festival','official'],
    ['2026-04-14','วันสงกรานต์','Songkran Festival','official'],
    ['2026-04-15','วันสงกรานต์ (เพิ่มเติม)','Songkran Festival (Extra)','official'],
    ['2026-05-01','วันแรงงานแห่งชาติ','National Labour Day','official'],
    ['2026-05-04','วันฉัตรมงคล','Coronation Day','official'],
    ['2026-06-01','ชดเชยวิสาขบูชา','Visakha Bucha (in lieu)','compensatory'],
    ['2026-06-03','วันพระบรมราชินี','HM Queen\'s Birthday','official'],
    ['2026-07-28','วันเฉลิมพระชนมพรรษา ร.10','HM King\'s Birthday','official'],
    ['2026-07-29','วันอาสาฬหบูชา','Asarnha Bucha Day','official'],
    ['2026-07-30','วันเข้าพรรษา','Buddhist Lent Day','official'],
    ['2026-08-12','วันแม่แห่งชาติ','HM Queen Mother\'s Birthday / Mother\'s Day','official'],
    ['2026-10-13','วันคล้ายวันสวรรคต ร.9','HM King Bhumibol Memorial Day','official'],
    ['2026-10-23','วันปิยมหาราช','Chulalongkorn Day','official'],
    ['2026-12-10','วันรัฐธรรมนูญ','Constitution Day','official'],
    ['2026-12-31','วันสิ้นปี','New Year\'s Eve','official'],
  ];
  holidays2026.forEach(h => dbRun('INSERT OR IGNORE INTO holidays (date,name,name_en,type,year) VALUES (?,?,?,?,2026)', h));
  saveDb();
  console.log('Holidays seeded: 18 days');
}

// ══════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'hris.html')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}
function fmtUser(u) {
  return { id:u.id, name:u.name, email:u.email, role:u.role,
    permissions: JSON.parse(u.permissions||'[]'),
    department:u.department, position:u.position, phone:u.phone,
    color:u.color, init:u.init,
    picture:u.picture||'', auth_provider:u.auth_provider||'local' };
}

// AUTH
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Incorrect email or password' });
  const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.json({ token, user: fmtUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  const { firstName, lastName, email, password, department, position, phone } = req.body;
  if (!firstName || !lastName || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already registered' });
  const name      = firstName + ' ' + lastName;
  const init      = (firstName[0] + (lastName[0]||'')).toUpperCase();
  const colors    = ['#3B82F6','#8B5CF6','#F59E0B','#EF4444','#10B981','#06B6D4'];
  const color     = colors[Math.floor(Math.random() * colors.length)];
  const userCount = dbGet('SELECT COUNT(*) as c FROM users').c;
  const role      = userCount === 0 ? 'admin' : 'employee';  // first user = admin
  const perms     = JSON.stringify(ROLE_DEFAULTS[role]);
  const hash      = bcrypt.hashSync(password, 10);
  const result    = dbRun('INSERT INTO users (name,email,password,role,permissions,department,position,phone,color,init,auth_provider) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [name, email.toLowerCase(), hash, role, perms, department||'', position||'', phone||'', color, init, 'local']);
  const empCount = dbGet('SELECT COUNT(*) as c FROM employees').c;
  dbRun('INSERT INTO employees (emp_id,user_id,name,email,department,position,join_date,color,init) VALUES (?,?,?,?,?,?,date("now"),?,?)',
    ['EMP-'+String(empCount+1).padStart(3,'0'), result.lastInsertRowid, name, email.toLowerCase(), department||'', position||'', color, init]);
  saveDb();
  const user  = dbGet('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
  const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.status(201).json({ token, user: fmtUser(user) });
});

// GOOGLE OAUTH
app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google login not configured on this server' });
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });
  try {
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    let user = dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) {
      // Auto-register: first user ever becomes admin
      const nameParts = (name||'User').split(' ');
      const init  = nameParts.map(p=>p[0]).slice(0,2).join('').toUpperCase() || 'U';
      const colors= ['#3B82F6','#8B5CF6','#F59E0B','#EF4444','#10B981','#06B6D4'];
      const color = colors[Math.floor(Math.random()*colors.length)];
      const userCount = dbGet('SELECT COUNT(*) as c FROM users').c;
      const role  = userCount === 0 ? 'admin' : 'employee';
      const perms = JSON.stringify(ROLE_DEFAULTS[role]);
      const result = dbRun(
        'INSERT INTO users (name,email,password,role,permissions,color,init,google_id,auth_provider,picture) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [name, email.toLowerCase(), '', role, perms, color, init, googleId, 'google', picture||'']
      );
      const empCount = dbGet('SELECT COUNT(*) as c FROM employees').c;
      dbRun('INSERT INTO employees (emp_id,user_id,name,email,join_date,color,init) VALUES (?,?,?,?,date("now"),?,?)',
        ['EMP-'+String(empCount+1).padStart(3,'0'), result.lastInsertRowid, name, email.toLowerCase(), color, init]);
      saveDb();
      user = dbGet('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
    } else if (!user.google_id) {
      dbRun('UPDATE users SET google_id=?,auth_provider=?,picture=? WHERE id=?', [googleId,'google',picture||'',user.id]);
      saveDb();
      user = dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
    }
    const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, user: fmtUser(user) });
  } catch(err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

app.post('/api/auth/forgot-password', (req, res) => {
  const user = dbGet('SELECT id FROM users WHERE email = ?', [(req.body.email||'').toLowerCase()]);
  if (!user) return res.status(404).json({ error: 'Email not found' });
  dbRun('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync('newpass123', 10), user.id]);
  saveDb();
  res.json({ message: 'Password reset to newpass123 (demo)' });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(fmtUser(user));
});

// EMPLOYEES
app.get('/api/employees', auth, (req, res) => {
  res.json(dbAll('SELECT * FROM employees ORDER BY name'));
});
app.post('/api/employees', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { name, email, department, position, join_date, work_model, phone, color, init } = req.body;
  const empCount = dbGet('SELECT COUNT(*) as c FROM employees').c;
  const emp_id   = 'EMP-' + String(empCount+1).padStart(3,'0');
  const result   = dbRun('INSERT INTO employees (emp_id,name,email,department,position,join_date,work_model,phone,color,init) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [emp_id, name, email, department, position, join_date, work_model||'Office', phone||'', color||'#6B7280', init||'?']);
  saveDb();
  res.status(201).json({ id: result.lastInsertRowid, emp_id });
});
app.put('/api/employees/:id', auth, requireRole('admin','hr_manager'), (req, res) => {
  const { name, department, position, status, work_model, phone } = req.body;
  dbRun('UPDATE employees SET name=?,department=?,position=?,status=?,work_model=?,phone=? WHERE id=?',
    [name, department, position, status, work_model, phone, req.params.id]);
  saveDb(); res.json({ ok: true });
});
app.delete('/api/employees/:id', auth, requireRole('admin'), (req, res) => {
  dbRun('DELETE FROM employees WHERE id = ?', [req.params.id]); saveDb(); res.json({ ok: true });
});

// ATTENDANCE
app.get('/api/attendance', auth, (req, res) => {
  const { userId, month } = req.query;
  const targetId = userId || req.user.id;
  if (String(targetId) !== String(req.user.id) && !['admin','hr_manager','hr_staff'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });
  let sql = 'SELECT * FROM attendance WHERE user_id = ?';
  const params = [targetId];
  if (month) { sql += ' AND date LIKE ?'; params.push(month + '%'); }
  res.json(dbAll(sql + ' ORDER BY date DESC', params));
});
app.get('/api/attendance/today', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(dbGet('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, today]) || null);
});
app.post('/api/attendance/checkin', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toLocaleTimeString('en-GB', { hour12:false, hour:'2-digit', minute:'2-digit' });
  const { location, note } = req.body;
  const existing = dbGet('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, today]);
  if (existing && existing.check_in) return res.status(409).json({ error: 'Already checked in today' });
  if (existing) {
    dbRun('UPDATE attendance SET check_in=?,location=?,note=? WHERE id=?', [now, location||'Office', note||'', existing.id]);
  } else {
    dbRun('INSERT INTO attendance (user_id,date,check_in,location,note,status) VALUES (?,?,?,?,?,?)',
      [req.user.id, today, now, location||'Office', note||'', 'Present']);
  }
  saveDb(); res.json({ check_in: now, date: today });
});
app.post('/api/attendance/checkout', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toLocaleTimeString('en-GB', { hour12:false, hour:'2-digit', minute:'2-digit' });
  const row   = dbGet('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, today]);
  if (!row || !row.check_in) return res.status(400).json({ error: 'Not checked in yet' });
  const [ih, im] = row.check_in.split(':').map(Number);
  const [oh, om] = now.split(':').map(Number);
  const mins      = (oh*60+om) - (ih*60+im);
  const workHours = Math.floor(mins/60) + 'h ' + String(mins%60).padStart(2,'0') + 'm';
  dbRun('UPDATE attendance SET check_out=?,work_hours=? WHERE id=?', [now, workHours, row.id]);
  saveDb(); res.json({ check_out: now, work_hours: workHours });
});

// RETROACTIVE ATTENDANCE
app.post('/api/attendance/retroactive', auth, (req, res) => {
  const { date, check_in, check_out, location, reason } = req.body;
  if (!date || !check_in) return res.status(400).json({ error: 'Date and check-in time required' });
  const today = new Date().toISOString().split('T')[0];
  if (date >= today) return res.status(400).json({ error: 'Can only submit retroactive for past dates' });
  // Calculate work hours if both provided
  let workHours = null;
  if (check_in && check_out) {
    const [ih, im] = check_in.split(':').map(Number);
    const [oh, om] = check_out.split(':').map(Number);
    const mins = (oh*60+om) - (ih*60+im);
    if (mins > 0) workHours = Math.floor(mins/60) + 'h ' + String(mins%60).padStart(2,'0') + 'm';
  }
  // Check if record already exists for that date
  const existing = dbGet('SELECT id FROM attendance WHERE user_id=? AND date=?', [req.user.id, date]);
  if (existing) return res.status(409).json({ error: 'Attendance record already exists for this date' });
  const result = dbRun(
    'INSERT INTO attendance (user_id,date,check_in,check_out,work_hours,location,note,status,is_retroactive,retro_status,retro_reason) VALUES (?,?,?,?,?,?,?,?,1,"Pending",?)',
    [req.user.id, date, check_in, check_out||null, workHours, location||'Office', '', 'Present', reason||'']
  );
  // Send inbox notification to managers
  const managers = dbAll('SELECT id FROM users WHERE role IN ("admin","hr_manager","hr_staff")');
  const requester = dbGet('SELECT name FROM users WHERE id=?', [req.user.id]);
  managers.forEach(m => {
    dbRun('INSERT INTO inbox (from_user,to_user,subject,body) VALUES (?,?,?,?)',
      [req.user.id, m.id,
       `[รออนุมัติ] บันทึกเวลาย้อนหลัง — ${requester.name}`,
       `${requester.name} ขอบันทึกเวลาย้อนหลังวันที่ ${date} เวลา ${check_in}${check_out?' – '+check_out:''}\nเหตุผล: ${reason||'-'}`
      ]);
  });
  saveDb();
  res.status(201).json({ id: result.lastInsertRowid, retro_status: 'Pending' });
});

app.get('/api/attendance/retroactive', auth, (req, res) => {
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let sql = `SELECT a.*, u.name as emp_name, u.init as emp_init, u.color as emp_color,
             ap.name as approver_name
             FROM attendance a
             JOIN users u ON a.user_id=u.id
             LEFT JOIN users ap ON a.retro_approved_by=ap.id
             WHERE a.is_retroactive=1`;
  const params = [];
  if (!isManager) { sql += ' AND a.user_id=?'; params.push(req.user.id); }
  else if (req.query.pending) { sql += ' AND a.retro_status="Pending"'; }
  res.json(dbAll(sql + ' ORDER BY a.date DESC', params));
});

app.put('/api/attendance/retroactive/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { status, note } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const row = dbGet('SELECT * FROM attendance WHERE id=? AND is_retroactive=1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  dbRun('UPDATE attendance SET retro_status=?,retro_approved_by=? WHERE id=?',
    [status, req.user.id, req.params.id]);
  // Notify requester
  const approver = dbGet('SELECT name FROM users WHERE id=?', [req.user.id]);
  const emoji = status === 'Approved' ? '✅' : '❌';
  dbRun('INSERT INTO inbox (from_user,to_user,subject,body) VALUES (?,?,?,?)',
    [req.user.id, row.user_id,
     `${emoji} บันทึกเวลาย้อนหลังวันที่ ${row.date} — ${status}`,
     `${approver.name} ${status==='Approved'?'อนุมัติ':'ไม่อนุมัติ'}การบันทึกเวลาย้อนหลังของคุณวันที่ ${row.date}${note?'\nหมายเหตุ: '+note:''}`
    ]);
  saveDb();
  res.json({ ok: true, status });
});

// LEAVE
app.get('/api/leave', auth, (req, res) => {
  const { scope } = req.query;
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let sql = 'SELECT lr.*, u.name as emp_name, u.init as emp_init, u.color as emp_color, a.name as approver_name FROM leave_requests lr JOIN users u ON lr.user_id=u.id LEFT JOIN users a ON lr.approved_by=a.id';
  const params = [];
  if (scope === 'pending' && isManager) sql += ' WHERE lr.status="Pending"';
  else if (scope === 'team' && isManager) {}
  else { sql += ' WHERE lr.user_id=?'; params.push(req.user.id); }
  res.json(dbAll(sql + ' ORDER BY lr.created_at DESC', params));
});
app.post('/api/leave', auth, (req, res) => {
  const { type, from_date, to_date, days, reason } = req.body;
  if (!type || !from_date || !to_date) return res.status(400).json({ error: 'Missing fields' });
  const result = dbRun('INSERT INTO leave_requests (user_id,type,from_date,to_date,days,reason) VALUES (?,?,?,?,?,?)',
    [req.user.id, type, from_date, to_date, days||1, reason||'']);
  saveDb(); res.status(201).json({ id: result.lastInsertRowid });
});
app.put('/api/leave/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { status, note } = req.body;
  dbRun('UPDATE leave_requests SET status=?,approved_by=?,note=? WHERE id=?', [status, req.user.id, note||'', req.params.id]);
  saveDb(); res.json({ ok: true });
});

// OT
app.get('/api/ot', auth, (req, res) => {
  const { scope } = req.query;
  const isManager = ['admin','hr_manager','hr_staff'].includes(req.user.role);
  let sql = 'SELECT ot.*, u.name as emp_name, u.init as emp_init, u.color as emp_color, a.name as approver_name FROM ot_requests ot JOIN users u ON ot.user_id=u.id LEFT JOIN users a ON ot.approved_by=a.id';
  const params = [];
  if (scope === 'pending' && isManager) sql += ' WHERE ot.status="Pending"';
  else if (scope === 'team' && isManager) {}
  else { sql += ' WHERE ot.user_id=?'; params.push(req.user.id); }
  res.json(dbAll(sql + ' ORDER BY ot.created_at DESC', params));
});
app.post('/api/ot', auth, (req, res) => {
  const { date, start_time, end_time, hours, type, reason } = req.body;
  if (!date || !start_time || !end_time || !reason) return res.status(400).json({ error: 'Missing fields' });
  const result = dbRun('INSERT INTO ot_requests (user_id,date,start_time,end_time,hours,type,reason) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, date, start_time, end_time, hours||'', type||'Voluntary', reason]);
  saveDb(); res.status(201).json({ id: result.lastInsertRowid });
});
app.put('/api/ot/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const { status, note } = req.body;
  dbRun('UPDATE ot_requests SET status=?,approved_by=?,note=? WHERE id=?', [status, req.user.id, note||'', req.params.id]);
  saveDb(); res.json({ ok: true });
});

// INBOX
app.get('/api/inbox', auth, (req, res) => {
  res.json(dbAll('SELECT i.*, u.name as from_name, u.init as from_init, u.color as from_color FROM inbox i LEFT JOIN users u ON i.from_user=u.id WHERE i.to_user=? ORDER BY i.created_at DESC', [req.user.id]));
});
app.post('/api/inbox', auth, (req, res) => {
  const { to_user, subject, body } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject required' });
  const result = dbRun('INSERT INTO inbox (from_user,to_user,subject,body) VALUES (?,?,?,?)',
    [req.user.id, to_user||null, subject, body||'']);
  saveDb(); res.status(201).json({ id: result.lastInsertRowid });
});
app.put('/api/inbox/:id/read', auth, (req, res) => {
  dbRun('UPDATE inbox SET is_read=1 WHERE id=? AND to_user=?', [req.params.id, req.user.id]);
  saveDb(); res.json({ ok: true });
});

// APPOINTMENTS
app.get('/api/appointments', auth, (req, res) => {
  const { month } = req.query;
  let sql = 'SELECT * FROM appointments WHERE user_id = ?';
  const params = [req.user.id];
  if (month) { sql += ' AND date LIKE ?'; params.push(month + '%'); }
  res.json(dbAll(sql + ' ORDER BY date,start_time', params));
});
app.post('/api/appointments', auth, (req, res) => {
  const { title, date, start_time, end_time, type, location, participants, notes } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'Title and date required' });
  const result = dbRun('INSERT INTO appointments (user_id,title,date,start_time,end_time,type,location,participants,notes) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.user.id, title, date, start_time||'', end_time||'', type||'meeting', location||'', participants||'', notes||'']);
  saveDb(); res.status(201).json({ id: result.lastInsertRowid });
});
app.delete('/api/appointments/:id', auth, (req, res) => {
  dbRun('DELETE FROM appointments WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  saveDb(); res.json({ ok: true });
});

// USERS (Admin)
app.get('/api/users', auth, requireRole('admin','hr_manager'), (req, res) => {
  const rows = dbAll('SELECT id,name,email,role,permissions,department,position,color,init,created_at FROM users ORDER BY name');
  res.json(rows.map(u => ({ ...u, permissions: JSON.parse(u.permissions||'[]') })));
});
app.put('/api/users/:id/permissions', auth, requireRole('admin'), (req, res) => {
  const { role, permissions } = req.body;
  dbRun('UPDATE users SET role=?,permissions=? WHERE id=?', [role, JSON.stringify(permissions), req.params.id]);
  saveDb(); res.json({ ok: true });
});

// STATS
app.get('/api/stats', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({
    totalEmployees: dbGet('SELECT COUNT(*) as c FROM employees').c,
    presentToday:   dbGet('SELECT COUNT(*) as c FROM attendance WHERE date=? AND check_in IS NOT NULL', [today]).c,
    pendingLeave:   dbGet('SELECT COUNT(*) as c FROM leave_requests WHERE status="Pending"').c,
    pendingOT:      dbGet('SELECT COUNT(*) as c FROM ot_requests WHERE status="Pending"').c,
  });
});

// HOLIDAYS
app.get('/api/holidays', (req, res) => {
  const { year, month } = req.query;
  let sql = 'SELECT * FROM holidays WHERE 1=1';
  const params = [];
  if (year)  { sql += ' AND year = ?';      params.push(Number(year)); }
  if (month) { sql += ' AND date LIKE ?';   params.push(`${year||'%'}-${String(month).padStart(2,'0')}-%`); }
  res.json(dbAll(sql + ' ORDER BY date', params));
});

app.post('/api/holidays', auth, requireRole('admin','hr_manager'), (req, res) => {
  const { date, name, name_en, type } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  const year = parseInt(date.slice(0,4));
  dbRun('INSERT OR REPLACE INTO holidays (date,name,name_en,type,year) VALUES (?,?,?,?,?)',
    [date, name, name_en||'', type||'official', year]);
  saveDb(); res.status(201).json({ ok: true });
});

app.delete('/api/holidays/:date', auth, requireRole('admin'), (req, res) => {
  dbRun('DELETE FROM holidays WHERE date = ?', [req.params.date]);
  saveDb(); res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ status:'ok', time: new Date().toISOString() }));

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════
initSqlJs({ locateFile: file => `${__dirname}/node_modules/sql.js/dist/${file}` }).then(SQL => {
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
    console.log('Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('Created new database');
  }
  initSchema();
  seedHolidays();  // seed Thai public holidays only
  app.listen(PORT, () => {
    console.log('');
    console.log('  Teams HRIS Backend Running');
    console.log('  http://localhost:' + PORT);
    console.log('  API: http://localhost:' + PORT + '/api');
    console.log('');
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
