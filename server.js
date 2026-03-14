const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://mission-control-server.onrender.com/auth/google/callback';
const TOKENS_FILE = path.join('/tmp', 'google_tokens.json');

let googleTokens = null;
let calendarEvents = [];

// Load tokens from disk on startup
try {
  if (fs.existsSync(TOKENS_FILE)) {
    googleTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    console.log('Google tokens loaded from disk');
  }
} catch(e) {
  console.log('No saved tokens found');
}

function saveTokens(tokens) {
  googleTokens = tokens;
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
  } catch(e) {
    console.log('Could not save tokens:', e.message);
  }
}

// ── CALENDAR ──────────────────────────────────────────────────────────────────
app.post('/calendar', (req, res) => {
  const { events } = req.body;
  if (events) {
    calendarEvents = events;
    console.log(`Calendar updated: ${typeof events === 'string' ? 'string format' : events.length + ' events'}`);
  }
  res.json({ success: true });
});

app.get('/calendar', (req, res) => {
  res.json({ events: calendarEvents });
});

// ── TODOIST ──────────────────────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  try {
    const [tasksRes, projectsRes] = await Promise.all([
      fetch('https://api.todoist.com/api/v1/tasks', { headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` } }),
      fetch('https://api.todoist.com/api/v1/projects', { headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` } })
    ]);
    const tasksData = await tasksRes.json();
    const projectsData = await projectsRes.json();
    res.json({ tasks: tasksData.results || tasksData, projects: projectsData.results || projectsData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/tasks/:id/close', async (req, res) => {
  try {
    await fetch(`https://api.todoist.com/api/v1/tasks/${req.params.id}/close`, { method: 'POST', headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GMAIL AUTH ────────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json();
    saveTokens(tokens);
    res.send('<h2 style="font-family:sans-serif;color:green">✅ Gmail connected permanently! Close this tab and refresh your dashboard.</h2>');
  } catch (err) { res.status(500).send('Auth failed: ' + err.message); }
});

async function refreshGoogleToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: googleTokens.refresh_token, grant_type: 'refresh_token' })
  });
  const data = await res.json();
  googleTokens.access_token = data.access_token;
  saveTokens(googleTokens);
}

// ── GMAIL EMAILS ──────────────────────────────────────────────────────────────
app.get('/emails', async (req, res) => {
  if (!googleTokens) return res.json({ emails: [], status: 'not_connected' });
  try {
    await refreshGoogleToken();
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=is:unread category:primary', { headers: { 'Authorization': `Bearer ${googleTokens.access_token}` } });
    const listData = await listRes.json();
    const messages = listData.messages || [];
    const emails = await Promise.all(messages.map(async (msg) => {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { 'Authorization': `Bearer ${googleTokens.access_token}` } });
      const msgData = await msgRes.json();
      const headers = msgData.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const fromName = from.replace(/<.*>/, '').replace(/"/g, '').trim() || from.split('@')[0];
      return { id: msg.id, from: fromName, subject, date };
    }));
    res.json({ emails, status: 'connected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
