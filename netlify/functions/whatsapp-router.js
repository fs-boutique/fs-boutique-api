// FS Boutique — WhatsApp router (Meta Cloud API)
// Receives inbound messages on +1 949 372 9980 (system line) and routes:
//   - From Fabio (FABIO_WHATSAPP): treat as Claw reminder → Asana task → ack reply
//   - From a cleaner (CLEANER_WHATSAPPS): log only, no automated action (cleaners reply to digests)
//   - From unknown: log + Telegram alert Fabio
// Also handles Meta's webhook verification handshake (GET request with hub.challenge).

const META_GRAPH = 'https://graph.facebook.com/v21.0';

function parseCleanerMap() {
  const raw = process.env.CLEANER_WHATSAPPS || '';
  const map = {};
  for (const pair of raw.split(',')) {
    const [num, name] = pair.split(':');
    if (num && name) map[num.trim()] = name.trim();
  }
  return map;
}

async function sendWhatsApp(to, text) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log('Meta credentials missing — cannot send reply');
    return false;
  }
  const res = await fetch(`${META_GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  console.log('WA send →', to, res.status);
  return res.ok;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return true;
  } catch (e) { console.log('TG send fail', e.message); return false; }
}

async function parseIntent(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'reminder', body: text };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system:
          'Extract intent from a WhatsApp message Fabio sent himself to capture a quick reminder. ' +
          'Reply ONLY with a single-line JSON object: ' +
          '{"intent":"reminder|note|other","body":"clean task text without filler","property":"Ibirapuera|Op Art|Moema II|Riviera|La Quinta|null","priority":"high|normal|low"}. ' +
          'Default intent is "reminder". If the message obviously mentions a property nickname, populate it; otherwise null. ' +
          'Strip prefixes like "lembrar de", "preciso", "tenho que" from the body.',
        messages: [{ role: 'user', content: text }],
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const m = raw.match(/\{[^}]+\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      return parsed;
    }
  } catch (e) { console.log('Intent parse fail', e.message); }
  return { intent: 'reminder', body: text, property: null, priority: 'normal' };
}

async function createAsanaTask(parsed, originalText) {
  const token = process.env.ASANA_TOKEN;
  const project = process.env.ASANA_PROJECT_OPERACOES;
  if (!token || !project) {
    console.log('Asana credentials missing');
    return null;
  }
  const name = parsed.body || originalText.slice(0, 120);
  const notes = [
    `Original WhatsApp: "${originalText}"`,
    `Intent: ${parsed.intent || 'reminder'}`,
    parsed.property ? `Property: ${parsed.property}` : null,
    `Source: Claw via WhatsApp (Meta Cloud API)`,
    `Captured: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { name, notes, projects: [project], workspace: '1214678919136252' } })
  });
  const data = await res.json();
  if (!res.ok) {
    console.log('Asana create fail', JSON.stringify(data).slice(0, 200));
    return null;
  }
  return data.data;
}

exports.handler = async (event) => {
  // --- Meta webhook verification handshake ---
  if (event.httpMethod === 'GET') {
    const mode = event.queryStringParameters?.['hub.mode'];
    const token = event.queryStringParameters?.['hub.verify_token'];
    const challenge = event.queryStringParameters?.['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'forbidden' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  // Meta delivers updates as {entry: [{changes: [{value: {messages: [...], contacts: [...]}}]}]}
  const messages = payload.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) {
    // Could be a status update (delivered/read) — ignore
    return { statusCode: 200, body: 'ignored' };
  }

  const FABIO = process.env.FABIO_WHATSAPP || '';
  const cleaners = parseCleanerMap();

  for (const msg of messages) {
    const from = msg.from;
    const text = msg.text?.body || '';
    if (!text) continue;

    if (from === FABIO) {
      const parsed = await parseIntent(text);
      const task = await createAsanaTask(parsed, text);
      if (task) {
        const taskUrl = `https://app.asana.com/0/${process.env.ASANA_PROJECT_OPERACOES}/${task.gid}`;
        await sendWhatsApp(from, `✅ tarefa criada: ${parsed.body || text.slice(0, 60)}\n${taskUrl}`);
      } else {
        await sendWhatsApp(from, `🔴 falha ao criar task — tenta de novo ou olha o log`);
      }
    } else if (cleaners[from]) {
      console.log(`Cleaner reply from ${cleaners[from]} (${from}): ${text.slice(0, 100)}`);
      // No action — just log. Cleaners reply to digests sometimes; we don't auto-respond.
    } else {
      console.log(`Unknown sender ${from}: ${text.slice(0, 100)}`);
      await sendTelegram(`🟡 WhatsApp inesperado de ${from}: ${text.slice(0, 200)}`);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
