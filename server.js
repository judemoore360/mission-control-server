const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;
const REDIRECT_URI = 'https://mission-control-server.onrender.com/auth/google/callback';

let googleTokens = null;
let calendarEvents = [];

if (process.env.GOOGLE_REFRESH_TOKEN) {
  googleTokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  console.log('Google tokens loaded from environment');
}

// ── CALENDAR ──────────────────────────────────────────────────────────────────
app.post('/calendar', (req, res) => {
  const { events } = req.body;
  if (events) { calendarEvents = events; }
  res.json({ success: true });
});

app.get('/calendar', (req, res) => {
  res.json({ events: calendarEvents });
});

// ── COMMUTE (Routes API) ──────────────────────────────────────────────────────
app.get('/commute', async (req, res) => {
  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.travelAdvisory'
      },
      body: JSON.stringify({
        origin: { address: 'Cross in Hand, East Sussex, TN21 0SR, UK' },
        destination: { address: 'East Sussex College, Cross Levels Way, Eastbourne, BN21 2UF, UK' },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        departureTime: new Date().toISOString()
      })
    });
    const data = await response.json();
    console.log('Routes API response:', JSON.stringify(data).slice(0, 300));
    const route = data.routes && data.routes[0];
    if (!route) return res.status(500).json({ error: 'No route found', raw: data });
    const mins = Math.round(parseInt(route.duration) / 60);
    const km = (route.distanceMeters / 1000).toFixed(1);
    res.json({ mins, distance: `${km} km`, status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    googleTokens = tokens;
    res.send(`
      <h2 style="font-family:sans-serif;color:green">✅ Gmail connected!</h2>
      <p style="font-family:sans-serif;margin:16px 0">Now do this one time to make it permanent:</p>
      <ol style="font-family:sans-serif;line-height:2">
        <li>Copy the refresh token below</li>
        <li>Go to Render → your service → Environment</li>
        <li>Add new variable: <strong>GOOGLE_REFRESH_TOKEN</strong></li>
        <li>Paste the token as the value and save</li>
      </ol>
      <p style="font-family:sans-serif;margin:16px 0"><strong>Your refresh token:</strong></p>
      <textarea style="width:100%;height:80px;font-size:12px;padding:8px">${tokens.refresh_token}</textarea>
    `);
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

// ── GMAIL EMAIL BODY ──────────────────────────────────────────────────────────
app.get('/emails/:id', async (req, res) => {
  if (!googleTokens) return res.status(401).json({ error: 'not_connected' });
  try {
    await refreshGoogleToken();
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.id}?format=full`,
      { headers: { 'Authorization': `Bearer ${googleTokens.access_token}` } }
    );
    const msgData = await msgRes.json();
    let body = '';
    const parts = msgData.payload.parts || [msgData.payload];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf8');
        break;
      }
    }
    body = body.replace(/\r\n/g, '\n').trim().slice(0, 1000);
    res.json({ body });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
