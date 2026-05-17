// Claude Mailbox — live messaging between Fabio's 3 Claudes
//   - Laptop Claude Code
//   - iMac Claude Code (Garage)
//   - Claw (WhatsApp bot)
//
// POST endpoint with two actions:
//   { action: "send", from, to, text, priority?, tags? }
//   { action: "check", for, since_ts?, mark_read? }
//
// Auth: shared secret in body (MAILBOX_SECRET env var on Netlify).
// Storage: Netlify Blobs store "claude-mailbox".
// TTL: 7 days for read messages, 14 days for unread.
// Optional: high-priority messages also ping Telegram so Fabio sees them.

let blobsModule = null;
async function getMailboxStore() {
  if (!blobsModule) {
    try { blobsModule = await import('@netlify/blobs'); }
    catch (e) { console.log('[mailbox] blobs unavailable:', e.message); return null; }
  }
  const siteID = process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (!siteID || !token) {
    console.log('[mailbox] missing SITE_ID or BLOBS_TOKEN');
    return null;
  }
  try {
    return blobsModule.getStore({ name: 'claude-mailbox', siteID, token });
  } catch (e) {
    console.log('[mailbox] getStore fail:', e.message);
    return null;
  }
}

const VALID_SURFACES = ['laptop', 'imac', 'claw'];

async function loadInbox(store, recipient) {
  if (!store) return [];
  try {
    const data = await store.get(`inbox-${recipient}`, { type: 'json' });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.log('[mailbox] loadInbox fail:', e.message);
    return [];
  }
}

async function saveInbox(store, recipient, msgs) {
  if (!store) return;
  // Prune: keep unread forever (up to 14 days), drop read older than 7 days
  const now = Date.now();
  const pruned = msgs.filter(m => {
    const ageMs = now - (m.ts || 0);
    if (m.read) return ageMs < 7 * 86400 * 1000;
    return ageMs < 14 * 86400 * 1000;
  });
  // Cap to last 100 msgs to avoid runaway
  const trimmed = pruned.slice(-100);
  try {
    await store.setJSON(`inbox-${recipient}`, trimmed);
  } catch (e) {
    console.log('[mailbox] saveInbox fail:', e.message);
  }
}

async function pingTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return true;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: 'invalid json' }; }

  const expectedSecret = process.env.MAILBOX_SECRET;
  if (!expectedSecret || body.secret !== expectedSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const store = await getMailboxStore();
  if (!store) {
    return { statusCode: 503, body: JSON.stringify({ error: 'mailbox store unavailable' }) };
  }

  // SEND
  if (body.action === 'send') {
    const { from, to, text, priority = 'normal', tags = [] } = body;
    if (!from || !to || !text) {
      return { statusCode: 400, body: JSON.stringify({ error: 'from + to + text required' }) };
    }
    if (!VALID_SURFACES.includes(from)) {
      return { statusCode: 400, body: JSON.stringify({ error: `invalid from. valid: ${VALID_SURFACES.join(', ')}` }) };
    }
    // to can be "all" or a single surface or a comma-separated list
    let recipients;
    if (to === 'all') {
      recipients = VALID_SURFACES.filter(s => s !== from);
    } else if (typeof to === 'string') {
      recipients = to.split(',').map(s => s.trim()).filter(s => VALID_SURFACES.includes(s) && s !== from);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid to' }) };
    }
    if (recipients.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'no valid recipients' }) };
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = {
      id,
      from,
      ts: Date.now(),
      text: text.slice(0, 4000),
      priority,
      tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
      read: false,
    };
    const written = [];
    for (const recipient of recipients) {
      const inbox = await loadInbox(store, recipient);
      inbox.push(msg);
      await saveInbox(store, recipient, inbox);
      written.push(recipient);
    }
    // High-priority cross-Claude messages also ping Telegram for Fabio's awareness
    if (priority === 'high') {
      await pingTelegram(`🔔 [${from} → ${written.join(',')}] ${text.slice(0, 200)}`);
    }
    console.log(`[mailbox] send from=${from} to=${written.join(',')} priority=${priority} id=${id}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, id, delivered_to: written }) };
  }

  // CHECK
  if (body.action === 'check') {
    const { for: forSurface, since_ts = 0, mark_read = true, include_read = false } = body;
    if (!VALID_SURFACES.includes(forSurface)) {
      return { statusCode: 400, body: JSON.stringify({ error: `invalid for. valid: ${VALID_SURFACES.join(', ')}` }) };
    }
    const inbox = await loadInbox(store, forSurface);
    const filtered = inbox.filter(m => m.ts > since_ts && (include_read || !m.read));
    if (mark_read) {
      for (const m of inbox) {
        if (filtered.find(f => f.id === m.id)) m.read = true;
      }
      await saveInbox(store, forSurface, inbox);
    }
    console.log(`[mailbox] check for=${forSurface} returned=${filtered.length} unread=${inbox.filter(m => !m.read).length}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        for: forSurface,
        messages: filtered,
        total_unread_after_check: inbox.filter(m => !m.read).length,
      }),
    };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'unknown action. use "send" or "check"' }) };
};
