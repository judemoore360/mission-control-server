const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIRECT_URI = 'https://mission-control-server.onrender.com/auth/google/callback';

let googleTokens = null;

if (process.env.GOOGLE_REFRESH_TOKEN) {
  googleTokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  console.log('Google tokens loaded from environment');
}

async function redisSet(key, value) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([['SET', key, value]])
  });
  const data = await res.json();
  console.log('Upstash set:', JSON.stringify(data));
  return data;
}

async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  let result = data.result;
  try { result = decodeURIComponent(result); } catch(e) {}
  if (result.startsWith('"') && result.endsWith('"')) {
    result = result.slice(1, -1);
  }
  result = result.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return result;
}

app.post('/calendar', async (req, res) => {
  try {
    const { events } = req.body;
    if (events) {
      await redisSet('calendar_events', events);
      console.log('Calendar saved to Upstash');
    }
    res.json({ success: true });
  } catch(e) {
    console.log('Calendar POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/calendar', async (req, res) => {
  try {
    const raw = await redisGet('calendar_events');
    console.log('Raw preview:', String(raw).slice(0, 150));
    if (!raw) return res.json({ events: [] });
    const events = String(raw)
      .split(/\\n|\n/)
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch(e) { return null; } })
      .filter(Boolean);
    console.log('Parsed events count:', events.length);
    res.json({ events });
  } catch(e) {
    console.log('Calendar GET error:', e.message);
    res.json({ events: [] });
  }
});

// ── ETORO ─────────────────────────────────────────────────────────────────────
app.get('/etoro', async (req, res) => {
  try {
    // Fetch eToro data and GBP exchange rate in parallel
    const [etoroRes, fxRes] = await Promise.all([
      fetch('https://public-api.etoro.com/api/v1/trading/info/real/pnl', {
        headers: {
          'x-api-key': process.env.ETORO_API_KEY,
          'x-user-key': process.env.ETORO_USER_KEY,
          'x-request-id': '550e8400-e29b-41d4-a716-446655440000'
        }
      }),
      fetch('https://api.frankfurter.app/latest?from=USD&to=GBP')
    ]);

    const etoroData = await etoroRes.json();
    const fxData    = await fxRes.json();
    const usdToGbp  = fxData.rates.GBP;

    const portfolio    = etoroData.clientPortfolio;
    const cash         = portfolio.credit || 0;
    const unrealizedPnL = portfolio.unrealizedPnL || 0;
    const totalInvested = portfolio.positions.reduce((sum, p) => sum + (p.amount || 0), 0);
    const equity        = cash + totalInvested + unrealizedPnL;

    // Fetch instrument names
    const instrumentIds = [...new Set(portfolio.positions.map(p => p.instrumentID))];
    let instrumentMap = {};
    try {
      const instrRes = await fetch(`https://public-api.etoro.com/api/v1/market-data/instruments?instrumentIds=${instrumentIds.join(',')}`, {
        headers: {
          'x-api-key': process.env.ETORO_API_KEY,
          'x-user-key': process.env.ETORO_USER_KEY,
          'x-request-id': '550e8400-e29b-41d4-a716-446655440001'
        }
      });
      const instrData = await instrRes.json();
      const instruments = instrData.instruments || instrData;
      const instruments = instrData.instrumentDisplayDatas || instrData.instruments || instrData;
if (Array.isArray(instruments)) {
  instruments.forEach(i => { instrumentMap[i.instrumentID] = i.symbolFull || i.instrumentDisplayName; });
}
    } catch(e) {
      console.log('Could not fetch instrument names:', e.message);
    }

    // Build positions list
    const positions = portfolio.positions.map(p => {
      const pnl     = p.unrealizedPnL?.pnL || 0;
      const pct     = p.amount > 0 ? (pnl / p.amount) * 100 : 0;
      const name    = instrumentMap[p.instrumentID] || `#${p.instrumentID}`;
      return {
        name,
        amount:    Math.round(p.amount * usdToGbp * 100) / 100,
        pnl:       Math.round(pnl * usdToGbp * 100) / 100,
        pct:       Math.round(pct * 10) / 10
      };
    }).sort((a, b) => b.amount - a.amount);

    res.json({
      equity:   Math.round(equity * usdToGbp * 100) / 100,
      invested: Math.round(totalInvested * usdToGbp * 100) / 100,
      pnl:      Math.round(unrealizedPnL * usdToGbp * 100) / 100,
      cash:     Math.round(cash * usdToGbp * 100) / 100,
      rate:     usdToGbp,
      positions,
      status: 'ok'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/commute', async (req, res) => {
  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      body: JSON.stringify({
        origin: { address: 'Cross in Hand, East Sussex, TN21 0SR, UK' },
        destination: { address: 'East Sussex College, Cross Levels Way, Eastbourne, BN21 2UF, UK' },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        departureTime: new Date(Date.now() + 60000).toISOString()
      })
    });
    const data = await response.json();
    const route = data.routes && data.routes[0];
    if (!route) return res.status(500).json({ error: 'No route found', raw: data });
    const mins = Math.round(parseInt(route.duration) / 60);
    const km = (route.distanceMeters / 1000).toFixed(1);
    res.json({ mins, distance: `${km} km`, status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    res.send(`<h2 style="font-family:sans-serif;color:green">Gmail connected!</h2><p style="font-family:sans-serif">Refresh token: <textarea style="width:100%;height:80px">${tokens.refresh_token}</textarea></p>`);
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

app.get('/emails/:id', async (req, res) => {
  if (!googleTokens) return res.status(401).json({ error: 'not_connected' });
  try {
    await refreshGoogleToken();
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.id}?format=full`, { headers: { 'Authorization': `Bearer ${googleTokens.access_token}` } });
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
