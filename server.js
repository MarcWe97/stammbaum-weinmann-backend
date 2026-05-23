const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Datastore = require('nedb-promises');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────
const db = {
  users:   Datastore.create({ filename: './data/users.db',   autoload: true }),
  people:  Datastore.create({ filename: './data/people.db',  autoload: true }),
  feed:    Datastore.create({ filename: './data/feed.db',    autoload: true }),
  prefs:   Datastore.create({ filename: './data/prefs.db',   autoload: true }),
};

const JWT_SECRET = process.env.JWT_SECRET || 'weinmann_secret_2026';
const RESEND_KEY = process.env.RESEND_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'stammbaum@weinmann.family';

// ── EMAIL ─────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) { console.log('Email skipped (no RESEND_KEY):', subject, 'to', to); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    const data = await res.json();
    console.log('Email sent:', data.id || data.message);
  } catch(e) { console.error('Email error:', e.message); }
}

function emailTemplate(title, content) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#0a0a0a;color:#f0d080;max-width:600px;margin:0 auto;padding:20px">
    <div style="text-align:center;border-bottom:2px solid #c9a84c;padding-bottom:20px;margin-bottom:24px">
      <h1 style="font-size:28px;color:#f0d080;margin:0">Familie Weinmann</h1>
      <p style="color:#8a7040;font-size:14px;margin:4px 0 0">Stammbaum · Familienchronik</p>
    </div>
    <h2 style="color:#c9a84c;font-size:20px">${title}</h2>
    ${content}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #333;font-size:12px;color:#555;text-align:center">
      Stammbaum Familie Weinmann · <a href="https://stammbaum-weinmann.onrender.com" style="color:#c9a84c">stammbaum-weinmann.onrender.com</a>
    </div>
  </body></html>`;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Token ungültig' }); }
}

// ── WEBSOCKET BROADCAST ───────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── SEED DATA ─────────────────────────────────────────────────
async function seedIfEmpty() {
  const count = await db.people.count({});
  if (count > 0) return;
  const seed = [
    {id:"ug0a",first:"Johann",last:"Weinmann",gender:"m",birth:"1870",birthplace:"Heilbronn",death:"1935",deathplace:"Stuttgart",job:"Winzer",notes:"Gründer des Familiennamens in der Region. Betrieb einen kleinen Weinberg am Neckar.",generation:0,x:-200,y:0},
    {id:"ug0b",first:"Katharina",last:"Weinmann",birthname:"Steiner",gender:"f",birth:"1875",birthplace:"Tübingen",death:"1948",deathplace:"Stuttgart",job:"Hausfrau",notes:"Hüterin der Familiengeschichten. Schrieb ein Tagebuch das noch heute existiert.",generation:0,x:0,y:0,partner:"ug0a",reltype:"married",marriage:"1896"},
    {id:"ug1a",first:"Karl",last:"Weinmann",gender:"m",birth:"1918",birthplace:"Stuttgart",death:"1989",deathplace:"Stuttgart",job:"Schreiner",notes:"Baute eine eigene Schreinerei auf. Liebte Volksmusik und Wandern.",generation:1,x:-280,y:220,parents:["ug0a","ug0b"]},
    {id:"ug1b",first:"Elfriede",last:"Weinmann",birthname:"Hoffmann",gender:"f",birth:"1922",birthplace:"Heilbronn",death:"1995",deathplace:"Stuttgart",job:"Hausfrau",notes:"Bekannt für ihre Schwarzwälder Kirschtorte. Liebte Gartenarbeit.",generation:1,x:-80,y:220,partner:"ug1a",reltype:"married",marriage:"1946"},
    {id:"ug1c",first:"Heinrich",last:"Bauer",gender:"m",birth:"1915",birthplace:"München",death:"1978",deathplace:"München",job:"Kaufmann",notes:"Betrieb ein Textilgeschäft in München.",generation:1,x:200,y:220},
    {id:"ug1d",first:"Rosa",last:"Bauer",birthname:"Schneider",gender:"f",birth:"1920",birthplace:"Augsburg",death:"2002",deathplace:"München",job:"Lehrerin",notes:"Unterrichtete über 30 Jahre Deutsch und Geschichte.",generation:1,x:400,y:220,partner:"ug1c",reltype:"married",marriage:"1947"},
    {id:"g2a",first:"Friedrich",last:"Weinmann",gender:"m",birth:"1948",birthplace:"Stuttgart",location:"Karlsruhe",job:"Ingenieur",notes:"Studierte Maschinenbau am KIT. Arbeitete bei Bosch.",generation:2,x:-380,y:440,parents:["ug1a","ug1b"]},
    {id:"g2b",first:"Ingrid",last:"Weinmann",birthname:"Müller",gender:"f",birth:"1950",birthplace:"Heidelberg",location:"Karlsruhe",job:"Ärztin",notes:"Allgemeinmedizinerin in Karlsruhe-Durlach.",generation:2,x:-180,y:440,partner:"g2a",reltype:"married",marriage:"1974"},
    {id:"g2c",first:"Werner",last:"Weinmann",gender:"m",birth:"1953",birthplace:"Stuttgart",location:"Hamburg",job:"Architekt",notes:"Spezialisiert auf Industriebauten.",generation:2,x:60,y:440,parents:["ug1a","ug1b"]},
    {id:"g2d",first:"Brigitte",last:"Weinmann",birthname:"Bauer",gender:"f",birth:"1952",birthplace:"München",location:"Hamburg",job:"Grafikdesignerin",notes:"Tochter von Heinrich und Rosa Bauer.",generation:2,x:260,y:440,partner:"g2c",reltype:"married",marriage:"1979",parents:["ug1c","ug1d"]},
    {id:"g2e",first:"Marianne",last:"Huber",birthname:"Bauer",gender:"f",birth:"1955",birthplace:"München",location:"München",job:"Musikerin",notes:"Cellistin im Symphonieorchester München.",generation:2,x:480,y:440,parents:["ug1c","ug1d"]},
    {id:"g2f",first:"Thomas",last:"Huber",gender:"m",birth:"1952",birthplace:"Regensburg",location:"München",job:"Jurist",notes:"Rechtsanwalt, Schwerpunkt Familienrecht.",generation:2,x:680,y:440,partner:"g2e",reltype:"married",marriage:"1980"},
    {id:"g3a",first:"Markus",last:"Weinmann",gender:"m",birth:"1976",birthplace:"Karlsruhe",location:"Berlin",job:"Softwareentwickler",generation:3,x:-480,y:660,parents:["g2a","g2b"]},
    {id:"g3b",first:"Julia",last:"Weinmann",gender:"f",birth:"1979",birthplace:"Karlsruhe",location:"Karlsruhe",job:"Pharmakologin",generation:3,x:-280,y:660,parents:["g2a","g2b"]},
    {id:"g3c",first:"Stefan",last:"Weinmann",gender:"m",birth:"1982",birthplace:"Hamburg",location:"Hamburg",job:"Journalist",generation:3,x:-60,y:660,parents:["g2c","g2d"]},
    {id:"g3d",first:"Laura",last:"Weinmann",gender:"f",birth:"1985",birthplace:"Hamburg",location:"Wien",job:"Modedesignerin",generation:3,x:140,y:660,parents:["g2c","g2d"]},
    {id:"g3e",first:"Felix",last:"Huber",gender:"m",birth:"1984",birthplace:"München",location:"München",job:"Arzt",generation:3,x:480,y:660,parents:["g2e","g2f"]},
    {id:"g3f",first:"Anna",last:"Huber",gender:"f",birth:"1988",birthplace:"München",location:"Leipzig",job:"Musikpädagogin",generation:3,x:680,y:660,parents:["g2e","g2f"]},
    {id:"g3g",first:"Sophie",last:"Kern",gender:"f",birth:"1977",birthplace:"Frankfurt",location:"Berlin",job:"UX-Designerin",generation:3,x:-680,y:660,partner:"g3a",reltype:"together"},
    {id:"g4a",first:"Leon",last:"Weinmann",gender:"m",birth:"2005",birthplace:"Berlin",location:"Berlin",notes:"Schüler. Musik und Programmierung.",generation:4,x:-680,y:880,parents:["g3a","g3g"]},
    {id:"g4b",first:"Mia",last:"Weinmann",gender:"f",birth:"2008",birthplace:"Berlin",location:"Berlin",notes:"Schülerin. Turnen.",generation:4,x:-480,y:880,parents:["g3a","g3g"]},
    {id:"g4c",first:"Luca",last:"Fischer",gender:"m",birth:"2010",birthplace:"Wien",location:"Wien",notes:"Sohn von Laura.",generation:4,x:140,y:880,parents:["g3d"]},
  ];
  // fix partners
  const pmap = {ug0a:"ug0b",ug1a:"ug1b",ug1c:"ug1d",g2a:"g2b",g2c:"g2d",g2e:"g2f",g3a:"g3g"};
  Object.entries(pmap).forEach(([a,b])=>{
    const pa=seed.find(p=>p.id===a),pb=seed.find(p=>p.id===b);
    if(pa)pa.partner=b; if(pb)pb.partner=a;
  });
  for (const p of seed) {
    p.createdAt = new Date().toISOString();
    p.createdBy = 'system';
    await db.people.insert(p);
  }
  console.log('Seed data inserted');
}

// ── ROUTES ────────────────────────────────────────────────────

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName } = req.body;
  if (!email || !password || !firstName) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  const existing = await db.users.findOne({ email: email.toLowerCase() });
  if (existing) return res.status(400).json({ error: 'E-Mail bereits registriert' });

  const hash = await bcrypt.hash(password, 12);
  const verifyToken = uuidv4();
  const user = {
    id: uuidv4(), email: email.toLowerCase(), password: hash,
    firstName, lastName: lastName || '', verified: false, verifyToken,
    createdAt: new Date().toISOString(), role: 'member'
  };
  await db.users.insert(user);

  const verifyUrl = `${process.env.BASE_URL || 'https://stammbaum-weinmann.onrender.com'}/api/auth/verify/${verifyToken}`;
  await sendEmail(email, 'Willkommen beim Stammbaum Familie Weinmann!',
    emailTemplate('Herzlich Willkommen!', `
      <p style="font-size:15px;color:#ccc">Hallo ${firstName},</p>
      <p style="font-size:15px;color:#ccc">Du wurdest zum Stammbaum der Familie Weinmann eingeladen.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${verifyUrl}" style="background:#c9a84c;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">E-Mail bestätigen</a>
      </p>
      <p style="font-size:13px;color:#666">Falls du dich nicht registriert hast, ignoriere diese E-Mail.</p>
    `)
  );

  const token = jwt.sign({ id: user.id, email: user.email, firstName, lastName: lastName||'' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, firstName, lastName: lastName||'', verified: false } });
});

// Verify email
app.get('/api/auth/verify/:token', async (req, res) => {
  const user = await db.users.findOne({ verifyToken: req.params.token });
  if (!user) return res.status(400).send('<h2>Ungültiger Link</h2>');
  await db.users.update({ _id: user._id }, { $set: { verified: true, verifyToken: null } });
  res.redirect('/?verified=1');
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.users.findOne({ email: email?.toLowerCase() });
  if (!user) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  const token = jwt.sign({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, verified: user.verified } });
});

// Get current user
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await db.users.findOne({ id: req.user.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, verified: user.verified, role: user.role });
});

// Get all people
app.get('/api/people', auth, async (req, res) => {
  const people = await db.people.find({});
  res.json(people);
});

// Add person
app.post('/api/people', auth, async (req, res) => {
  const p = { ...req.body, id: req.body.id || uuidv4(), createdAt: new Date().toISOString(), createdBy: req.user.id };
  await db.people.insert(p);

  // Feed entry
  const feedEntry = {
    id: uuidv4(), type: 'new_person', personId: p.id,
    personName: `${p.first} ${p.last || ''}`.trim(),
    userId: req.user.id, userName: `${req.user.firstName} ${req.user.lastName}`.trim(),
    message: `${req.user.firstName} hat ${p.first} ${p.last || ''} hinzugefügt`,
    createdAt: new Date().toISOString()
  };
  await db.feed.insert(feedEntry);
  broadcast({ type: 'feed', entry: feedEntry });
  broadcast({ type: 'person_added', person: p });

  // Notify subscribed users
  notifyUsers('new_person', feedEntry);
  res.json(p);
});

// Update person
app.put('/api/people/:id', auth, async (req, res) => {
  const { _id, ...updates } = req.body;
  await db.people.update({ id: req.params.id }, { $set: { ...updates, updatedAt: new Date().toISOString(), updatedBy: req.user.id } });
  const p = await db.people.findOne({ id: req.params.id });

  const feedEntry = {
    id: uuidv4(), type: 'update_person', personId: p.id,
    personName: `${p.first} ${p.last || ''}`.trim(),
    userId: req.user.id, userName: `${req.user.firstName} ${req.user.lastName}`.trim(),
    message: `${req.user.firstName} hat ${p.first} ${p.last || ''} aktualisiert`,
    createdAt: new Date().toISOString()
  };
  await db.feed.insert(feedEntry);
  broadcast({ type: 'feed', entry: feedEntry });
  broadcast({ type: 'person_updated', person: p });
  notifyUsers('update_person', feedEntry);
  res.json(p);
});

// Delete person
app.delete('/api/people/:id', auth, async (req, res) => {
  const p = await db.people.findOne({ id: req.params.id });
  await db.people.remove({ id: req.params.id });
  if (p) {
    const feedEntry = {
      id: uuidv4(), type: 'delete_person',
      personName: `${p.first} ${p.last || ''}`.trim(),
      userId: req.user.id, userName: `${req.user.firstName} ${req.user.lastName}`.trim(),
      message: `${req.user.firstName} hat ${p.first} ${p.last || ''} entfernt`,
      createdAt: new Date().toISOString()
    };
    await db.feed.insert(feedEntry);
    broadcast({ type: 'feed', entry: feedEntry });
  }
  broadcast({ type: 'person_deleted', id: req.params.id });
  res.json({ ok: true });
});

// Get feed
app.get('/api/feed', auth, async (req, res) => {
  const entries = await db.feed.find({}).sort({ createdAt: -1 }).limit(50);
  res.json(entries);
});

// Get/set notification prefs
app.get('/api/prefs', auth, async (req, res) => {
  let prefs = await db.prefs.findOne({ userId: req.user.id });
  if (!prefs) prefs = { userId: req.user.id, notify_new_person: true, notify_update_person: false, notify_birthday: true };
  res.json(prefs);
});

app.put('/api/prefs', auth, async (req, res) => {
  const existing = await db.prefs.findOne({ userId: req.user.id });
  if (existing) {
    await db.prefs.update({ userId: req.user.id }, { $set: req.body });
  } else {
    await db.prefs.insert({ userId: req.user.id, ...req.body });
  }
  res.json({ ok: true });
});

// Stats
app.get('/api/stats', auth, async (req, res) => {
  const totalPeople = await db.people.count({});
  const activeUsers = await db.users.count({ verified: true });
  const allUsers = await db.users.count({});
  const people = await db.people.find({});
  const generations = people.length ? Math.max(...people.map(p => p.generation || 0)) + 1 : 0;
  const genCounts = {};
  people.forEach(p => { genCounts[p.generation || 0] = (genCounts[p.generation || 0] || 0) + 1; });
  res.json({ totalPeople, activeUsers, allUsers, generations, genCounts });
});

// Get all registered users (for display)
app.get('/api/users', auth, async (req, res) => {
  const users = await db.users.find({});
  res.json(users.map(u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, verified: u.verified, createdAt: u.createdAt })));
});

// Notify users helper
async function notifyUsers(eventType, feedEntry) {
  const users = await db.users.find({ verified: true });
  for (const user of users) {
    if (user.id === feedEntry.userId) continue; // don't notify yourself
    const prefs = await db.prefs.findOne({ userId: user.id });
    const shouldNotify = !prefs || prefs[`notify_${eventType}`] !== false;
    if (shouldNotify && user.email) {
      await sendEmail(user.email, `Stammbaum Weinmann: ${feedEntry.personName}`,
        emailTemplate('Neuigkeit im Stammbaum', `
          <p style="font-size:15px;color:#ccc">Hallo ${user.firstName},</p>
          <p style="font-size:16px;color:#f0d080">${feedEntry.message}</p>
          <p style="text-align:center;margin:24px 0">
            <a href="https://stammbaum-weinmann.onrender.com" style="background:#c9a84c;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Stammbaum öffnen</a>
          </p>
        `)
      );
    }
  }
}

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  const fs = require('fs');
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  await seedIfEmpty();
  console.log(`Stammbaum Backend läuft auf Port ${PORT}`);
});
