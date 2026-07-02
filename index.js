require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const SECRET = process.env.SERVER_SECRET || '';
const CALL_TTL_MS = 30 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json());

const callsByFaction = new Map();

function requireAuth(req, res, next) {
  if (!SECRET) return next();
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cleanupExpired() {
  const now = Date.now();
  for (const [factionId, members] of callsByFaction) {
    for (const [memberId, call] of members) {
      if (now - call.createdAt > CALL_TTL_MS) {
        members.delete(memberId);
      }
    }
    if (members.size === 0) callsByFaction.delete(factionId);
  }
}
setInterval(cleanupExpired, 60 * 1000);

app.get('/', (req, res) => res.json({ ok: true, service: 'torn-war-helper' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/calls', requireAuth, (req, res) => {
  const factionId = String(req.query.factionId || '');
  if (!factionId) return res.status(400).json({ error: 'factionId required' });
  const members = callsByFaction.get(factionId);
  const calls = members ? Array.from(members.values()) : [];
  res.json({ success: true, calls });
});

app.post('/api/call', requireAuth, (req, res) => {
  const { factionId, memberId, memberName, callerId, callerName } = req.body || {};
  if (!factionId || !memberId || !callerId) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  let members = callsByFaction.get(String(factionId));
  if (!members) {
    members = new Map();
    callsByFaction.set(String(factionId), members);
  }
  const existing = members.get(String(memberId));
  if (existing && String(existing.callerId) !== String(callerId)) {
    return res.status(409).json({ error: 'already_called', call: existing });
  }
  const call = {
    id: crypto.randomUUID(),
    memberId: String(memberId),
    memberName: memberName || '',
    callerId: String(callerId),
    callerName: callerName || '',
    createdAt: Date.now(),
  };
  members.set(String(memberId), call);
  res.json({ success: true, call });
});

app.post('/api/call/:id/cancel', requireAuth, (req, res) => {
  const { id } = req.params;
  const { factionId } = req.body || {};
  const members = callsByFaction.get(String(factionId || ''));
  if (members) {
    for (const [memberId, call] of members) {
      if (call.id === id) {
        members.delete(memberId);
        break;
      }
    }
  }
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Torn War Helper server listening on :${PORT}`);
  if (!SECRET) {
    console.log('WARNING: SERVER_SECRET is not set — anyone who finds this URL can read/write calls.');
  }
});
