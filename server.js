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
  cal_notes: {}         // { userId: { "YYYY-MM-DD": "note text" } }
};

const STORE_KEYS = ['users','employees','attendance','leave_requests','ot_requests','inbox','appointments','holidays','_seq','departments','cal_notes'];

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

function seedHolidays() {
  if (store.holidays.length > 0) return;
  const holidays2026 = [
    {date:'2026-01-01',name:'วันขึ้นปีใหม่',name_en:"New Year's Day",type:'official'},
    {date:'2026-01-02',name:'วันหยุดพิเศษ (ครม.)',name_en:'Special Holiday',type:'special'},
    {date:'2026-04-06',name:'วันจักรี',name_en:'Chakri Memorial Day',type:'official'},
    {date:'2026-04-13',name:'วันสงกรานต์',name_en:'Songkran Festival',type:'official'},
    {date:'2026-04-14',name:'วันสงกรานต์',name_en:'Songkran Festival',type:'official'},
    {date:'2026-04-15',name:'วันสงกรานต์ (เพิ่มเติม)',name_en:'Songkran Festival (Extra)',type:'official'},
    {date:'2026-05-01',name:'วันแรงงานแห่งชาติ',name_en:'National Labour Day',type:'official'},
    {date:'2026-05-04',name:'วันฉัตรมงคล',name_en:'Coronation Day',type:'official'},
    {date:'2026-06-01',name:'ชดเชยวิสาขบูชา',name_en:'Visakha Bucha (in lieu)',type:'compensatory'},
    {date:'2026-06-03',name:'วันพระบรมราชินี',name_en:"HM Queen's Birthday",type:'official'},
    {date:'2026-07-28',name:'วันเฉลิมพระชนมพรรษา ร.10',name_en:"HM King's Birthday",type:'official'},
    {date:'2026-07-29',name:'วันอาสาฬหบูชา',name_en:'Asarnha Bucha Day',type:'official'},
    {date:'2026-07-30',name:'วันเข้าพรรษา',name_en:'Buddhist Lent Day',type:'official'},
    {date:'2026-08-12',name:'วันแม่แห่งชาติ',name_en:"HM Queen Mother's Birthday / Mother's Day",type:'official'},
    {date:'2026-10-13',name:'วันคล้ายวันสวรรคต ร.9',name_en:'HM King Bhumibol Memorial Day',type:'official'},
    {date:'2026-10-23',name:'วันปิยมหาราช',name_en:'Chulalongkorn Day',type:'official'},
    {date:'2026-12-10',name:'วันรัฐธรรมนูญ',name_en:'Constitution Day',type:'official'},
    {date:'2026-12-31',name:'วันสิ้นปี',name_en:"New Year's Eve",type:'official'},
  ];
  holidays2026.forEach(h => {
    if (!store.holidays.find(x => x.date === h.date)) {
      store.holidays.push({ id: genId('holidays'), ...h, year: 2026 });
    }
  });
  saveDb();
  console.log('Holidays seeded:', store.holidays.length);
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
  const emp = store.employees.find(e => e.user_id === u.id);
  return { id:u.id, name:u.name, email:u.email, role:u.role,
    permissions: typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions,
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
  const user = store.users.find(u => u.email === email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Incorrect email or password' });
  const token = jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.json({ token, user: fmtUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  const { firstName, lastName, email, password, department, position, phone } = req.body;
  if (!firstName || !lastName || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (store.users.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
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
  const empId = 'EMP-' + String(store.employees.length + 1).padStart(3,'0');
  store.employees.push({
    id: genId('employees'), emp_id: empId, user_id: newUser.id,
    name, email: email.toLowerCase(), department: department||'', position: position||'',
    join_date: new Date().toISOString().split('T')[0], status:'Active', work_model:'Office',
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
      const empId = 'EMP-' + String(store.employees.length + 1).padStart(3,'0');
      store.employees.push({
        id: genId('employees'), emp_id: empId, user_id: newUser.id,
        name, email: email.toLowerCase(), department:'', position:'',
        join_date: new Date().toISOString().split('T')[0], status:'Active', work_model:'Office',
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

app.post('/api/auth/forgot-password', (req, res) => {
  const user = store.users.find(u => u.email === (req.body.email||'').toLowerCase());
  if (!user) return res.status(404).json({ error: 'Email not found' });
  user.password = bcrypt.hashSync('newpass123', 10);
  saveDb();
  res.json({ message: 'Password reset to newpass123 (demo)' });
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
  const empId = 'EMP-' + String(store.employees.length + 1).padStart(3,'0');
  const emp = {
    id: genId('employees'), emp_id: empId, user_id: null,
    name, email: email||'', department: department||'', position: position||'',
    join_date: join_date||new Date().toISOString().split('T')[0], status:'Active',
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
  const today = new Date().toISOString().split('T')[0];
  res.json(store.attendance.find(a => a.user_id === req.user.id && a.date === today) || null);
});
app.post('/api/attendance/checkin', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toLocaleTimeString('en-GB', { hour12:false, hour:'2-digit', minute:'2-digit' });
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
  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toLocaleTimeString('en-GB', { hour12:false, hour:'2-digit', minute:'2-digit' });
  const row   = store.attendance.find(a => a.user_id === req.user.id && a.date === today);
  if (!row || !row.check_in) return res.status(400).json({ error: 'Not checked in yet' });
  const [ih, im] = row.check_in.split(':').map(Number);
  const [oh, om] = now.split(':').map(Number);
  const mins = (oh*60+om) - (ih*60+im);
  row.check_out   = now;
  row.work_hours  = Math.floor(mins/60) + 'h ' + String(mins%60).padStart(2,'0') + 'm';
  saveDb(); res.json({ check_out: now, work_hours: row.work_hours });
});

// RETROACTIVE ATTENDANCE
app.post('/api/attendance/retroactive', auth, (req, res) => {
  const { date, check_in, check_out, location, reason } = req.body;
  if (!date || !check_in) return res.status(400).json({ error: 'Date and check-in time required' });
  const today = new Date().toISOString().split('T')[0];
  if (date >= today) return res.status(400).json({ error: 'Can only submit retroactive for past dates' });
  let workHours = null;
  if (check_in && check_out) {
    const [ih,im] = check_in.split(':').map(Number);
    const [oh,om] = check_out.split(':').map(Number);
    const mins = (oh*60+om) - (ih*60+im);
    if (mins > 0) workHours = Math.floor(mins/60) + 'h ' + String(mins%60).padStart(2,'0') + 'm';
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
app.post('/api/leave', auth, (req, res) => {
  const { type, from_date, to_date, days, reason } = req.body;
  if (!type || !from_date || !to_date) return res.status(400).json({ error: 'Missing fields' });
  const row = {
    id: genId('leave_requests'), user_id: req.user.id, type, from_date, to_date,
    days: days||1, reason: reason||'', status:'Pending',
    approved_by: null, note:'', created_at: new Date().toISOString()
  };
  store.leave_requests.push(row);
  saveDb(); res.status(201).json({ id: row.id });
});
app.put('/api/leave/:id/status', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const row = store.leave_requests.find(r => r.id == req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  row.status = status; row.approved_by = req.user.id; row.note = note||'';
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
  row.status = status; row.approved_by = req.user.id; row.note = note||'';
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
  const row = {
    id: genId('inbox'), from_user: req.user.id, to_user: to_user||null,
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
    permissions: typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions,
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
    // Allow self-restore of employment fields from local cache after DB reset
    if (start_date    !== undefined && start_date    !== '') emp.start_date    = start_date;
    if (contract_type !== undefined && contract_type !== '') emp.contract_type = contract_type;
    if (work_type     !== undefined && work_type     !== '') emp.work_type     = work_type;
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
  user.role = role; user.permissions = JSON.stringify(permissions);
  saveDb(); res.json({ ok: true });
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, requireRole('admin','hr_manager','hr_staff'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({
    totalEmployees: store.employees.length,
    presentToday:   store.attendance.filter(a => a.date === today && a.check_in).length,
    pendingLeave:   store.leave_requests.filter(r => r.status === 'Pending').length,
    pendingOT:      store.ot_requests.filter(r => r.status === 'Pending').length,
    onLeaveToday:   store.leave_requests.filter(r => r.status === 'Approved' && r.start_date <= today && r.end_date >= today).length,
  });
});

// ── HOLIDAYS ──────────────────────────────────────────────────────────────────
app.get('/api/holidays', (req, res) => {
  const { year, month } = req.query;
  let rows = [...store.holidays];
  if (year)  rows = rows.filter(h => h.year === Number(year));
  if (month) rows = rows.filter(h => h.date && h.date.startsWith(`${year||''}-${String(month).padStart(2,'0')}-`));
  res.json([...rows].sort((a,b) => a.date.localeCompare(b.date)));
});
app.post('/api/holidays', auth, requireRole('admin','hr_manager'), (req, res) => {
  const { date, name, name_en, type } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  const year = parseInt(date.slice(0,4));
  const existing = store.holidays.find(h => h.date === date);
  if (existing) { existing.name = name; existing.name_en = name_en||''; existing.type = type||'official'; }
  else store.holidays.push({ id: genId('holidays'), date, name, name_en: name_en||'', type: type||'official', year });
  saveDb(); res.status(201).json({ ok: true });
});
app.delete('/api/holidays/:date', auth, requireRole('admin'), (req, res) => {
  store.holidays = store.holidays.filter(h => h.date !== req.params.date);
  saveDb(); res.json({ ok: true });
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
    position: 'System Admin', join_date: new Date().toISOString().split('T')[0],
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
