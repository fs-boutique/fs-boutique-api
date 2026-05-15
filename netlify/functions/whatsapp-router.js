// FS Boutique — WhatsApp router (Meta Cloud API)
// Inbound to +1 949 372 9980 (system line) routes:
//   - From Fabio (FABIO_WHATSAPP): classify reminder vs conversation
//       reminder → Asana task + ack
//       conversation → Claude (Sonnet) reply with multi-turn memory + tool use
//   - From a cleaner (CLEANER_WHATSAPPS): log + forward to Fabio's personal WhatsApp
//   - From unknown: log + Telegram alert
// Also handles Meta's webhook verification handshake (GET request with hub.challenge).

const META_GRAPH = 'https://graph.facebook.com/v21.0';
const crypto = require('crypto');

// Forward incoming WhatsApp message to OpenClaw VPS endpoint with HMAC signature.
// OpenClaw on VPS handles classification, memory, response. Netlify is thin proxy.
async function forwardToVPS(payload) {
  const url = process.env.CLAW_VPS_URL;
  const secret = process.env.CLAW_HMAC_SECRET;
  if (!url || !secret) {
    console.log('VPS forward: missing CLAW_VPS_URL or CLAW_HMAC_SECRET');
    return false;
  }
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claw-Signature': signature },
      body,
    });
    console.log('VPS forward:', res.status, 'payload bytes:', body.length);
    return res.ok;
  } catch (e) {
    console.log('VPS forward fail:', e.message);
    return false;
  }
}

// --- Conversation memory (Netlify Blobs) ---
let blobsModule = null;
async function getMemoryStore() {
  if (!blobsModule) {
    try { blobsModule = await import('@netlify/blobs'); }
    catch (e) { console.log('Blobs unavailable:', e.message); return null; }
  }
  try { return blobsModule.getStore({ name: 'claw-conversation' }); }
  catch (e) { console.log('getStore fail:', e.message); return null; }
}

async function loadHistory(phone) {
  const store = await getMemoryStore();
  if (!store) { console.log('loadHistory: store null'); return []; }
  try {
    const data = await store.get(`hist-${phone}`, { type: 'json' });
    if (!data) { console.log(`loadHistory: no data for ${phone}`); return []; }
    // Drop messages older than 12h
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    const filtered = (data || []).filter(m => m.ts > cutoff);
    console.log(`loadHistory: ${filtered.length} msgs (${data.length} total) for ${phone}`);
    return filtered;
  } catch (e) { console.log('loadHistory fail:', e.message); return []; }
}

async function saveHistory(phone, history) {
  const store = await getMemoryStore();
  if (!store) { console.log('saveHistory: store null'); return; }
  try {
    // Cap to last 20 turns
    const trimmed = history.slice(-20);
    await store.setJSON(`hist-${phone}`, trimmed);
    console.log(`saveHistory: saved ${trimmed.length} msgs for ${phone}`);
  } catch (e) { console.log('saveHistory fail:', e.message); }
}

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

// Haiku classifier — reminder vs conversation
async function classify(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { type: 'conversation' };
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
          'You classify WhatsApp messages Fabio sends to his assistant Claw. ' +
          'DEFAULT to "conversation". Only return "reminder" when there is an EXPLICIT reminder/todo keyword.\n\n' +
          '"reminder" — ONLY when message starts with or clearly contains:\n' +
          '- "lembrar de ...", "lembra de ..."\n' +
          '- "remember to ...", "remind me to ..."\n' +
          '- "TODO: ...", "task: ..."\n' +
          '- "preciso lembrar de ...", "anota: ..."\n\n' +
          '"conversation" — EVERYTHING ELSE, including:\n' +
          '- Statements/facts ("cancelar a reservação em Bottega Angelina")\n' +
          '- Questions ("como tá ocupação Moema?")\n' +
          '- Discussions/thoughts ("acho que devíamos baixar preço")\n' +
          '- Requests for help ("rascunha email pra Zen", "manda msg pra Ronilde")\n' +
          '- Imperatives without explicit reminder framing ("cancelar X", "checar Y")\n\n' +
          'When in doubt → "conversation". Fabio will explicitly say "lembrar de" when he wants a task.\n\n' +
          'Reply ONLY with single-line JSON: {"type":"reminder|conversation","body":"clean task text (only if reminder, strip the prefix)","property":"Ibirapuera|Op Art|Moema II|Riviera|La Quinta|null"}.',
        messages: [{ role: 'user', content: text }],
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const m = raw.match(/\{[^}]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) { console.log('Classify fail', e.message); }
  return { type: 'conversation' };
}

// Sonnet conversational reply with multi-turn memory + retry/fallback on overload
async function callClaudeWithFallback(key, systemPrompt, messages) {
  const models = ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
  let lastError = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages })
        });
        const data = await res.json();
        if (data.content?.[0]?.text) {
          if (model !== 'claude-sonnet-4-6') console.log(`Used fallback model: ${model}`);
          return data.content[0].text.trim();
        }
        lastError = data.error?.type || 'empty_response';
        console.log(`Claude ${model} attempt ${attempt + 1}: ${lastError}`);
        if (lastError === 'overloaded_error' && attempt === 0) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        break; // try next model
      } catch (e) {
        lastError = e.message;
        console.log(`Claude ${model} network error:`, e.message);
        break;
      }
    }
  }
  return `⚠️ Anthropic API instável agora (${lastError}). Manda de novo em 30s.`;
}

async function converseWithClaude(text, phone) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return 'Claude API key missing.';

  const history = await loadHistory(phone);
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: text });

  const systemPrompt =
    'You are Claw, Fabio\'s executive assistant for FS Boutique (5 STR properties in São Paulo + La Quinta, CA). ' +
    'You communicate with him via WhatsApp on his system line +1 949 372 9980. ' +
    'Reply short, direct, no preamble. Match the language Fabio writes in (PT-BR or EN). ' +
    'You have memory of recent messages in this thread (last ~12h).\n\n' +
    'CRITICAL RULES:\n' +
    '- No emojis unless Fabio uses them first.\n' +
    '- Never say "padrão boutique", "[word] boutique", "FS Boutique standard" — strict brand rule.\n' +
    '- Use ✅ / ⚠️ / ❌ for status if needed (green check, yellow warning triangle, red X).\n' +
    '- You are running inside a Netlify webhook — NO live tool access yet. You can\'t query Guesty, Notion, HostBuddy directly in this version.\n' +
    '- If Fabio asks for live data (e.g. "what\'s arriving today", "show me Moema reservations"), respond: "Pra isso preciso de acesso live a Guesty/Notion — ainda não tô equipado. Quer que eu chame Claude Code no Mac?"\n' +
    '- For straight questions you can answer from training (general advice, opinions, drafting messages, brainstorming), respond directly.\n' +
    '- For action requests (mandar mensagem pra cleaner X, mudar SOP, etc), respond: "Não tenho ações habilitadas ainda. Por enquanto sou só conversa + reminder. Posso te ajudar a pensar/rascunhar."\n' +
    '- Properties: Ibirapuera, Op Art (Moema), Moema II, Riviera, La Quinta. Under construction: 25h, Ritmo Itaim.\n' +
    'Keep replies under 4 lines unless Fabio asks for more detail.';

  const reply = await callClaudeWithFallback(key, systemPrompt, messages);

  // Persist this turn only if we got a real reply (skip on overload error msg)
  if (!reply.startsWith('⚠️ Anthropic API instável')) {
    const ts = Date.now();
    history.push({ role: 'user', content: text, ts });
    history.push({ role: 'assistant', content: reply, ts });
    await saveHistory(phone, history);
  }

  return reply;
}

// Download WhatsApp audio media and transcribe via OpenAI Whisper
async function transcribeAudio(mediaId) {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!metaToken || !openaiKey) {
    console.log('Audio transcription credentials missing');
    return null;
  }
  try {
    // 1. Get media URL from Meta
    const mediaRes = await fetch(`${META_GRAPH}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${metaToken}` }
    });
    const mediaInfo = await mediaRes.json();
    if (!mediaInfo.url) {
      console.log('No media URL', JSON.stringify(mediaInfo).slice(0, 200));
      return null;
    }

    // 2. Download audio binary (Meta requires auth header for CDN URL)
    const audioRes = await fetch(mediaInfo.url, {
      headers: { 'Authorization': `Bearer ${metaToken}` }
    });
    if (!audioRes.ok) {
      console.log('Audio download fail', audioRes.status);
      return null;
    }
    const audioBuffer = await audioRes.arrayBuffer();
    const mime = mediaInfo.mime_type || 'audio/ogg';
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'ogg';

    // 3. POST to OpenAI Whisper via multipart/form-data
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mime }), `audio.${ext}`);
    formData.append('model', 'whisper-1');
    // No language hint — auto-detect (Fabio mixes PT/EN heavily; forcing pt mistranscribes English words)

    // Force pt to prevent Whisper auto-detect from picking random languages
    // on short clips. Add English-aware prompt so mixed PT+EN code-switching
    // transcribes EN words correctly in English (not phonetic-PT).
    formData.append('language', 'pt');
    formData.append('prompt', 'Fabio fala português brasileiro misturando palavras em inglês: meeting, checkout, check-in, booking, occupancy, rate, listing, Airbnb, Booking, dashboard, owner, host, guest, cleaner, Asana, WhatsApp, Claw, Claude.');
    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData
    });
    const whisperData = await whisperRes.json();
    if (!whisperRes.ok) {
      console.log('Whisper fail', JSON.stringify(whisperData).slice(0, 200));
      return null;
    }
    console.log('Transcribed:', (whisperData.text || '').slice(0, 100));
    return whisperData.text || null;
  } catch (e) {
    console.log('transcribeAudio error:', e.message);
    return null;
  }
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
  // Meta webhook verification handshake
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

  const messages = payload.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) {
    return { statusCode: 200, body: 'ignored' };
  }

  const FABIO = process.env.FABIO_WHATSAPP || '';
  const cleaners = parseCleanerMap();

  for (const msg of messages) {
    const from = msg.from;
    let text = msg.text?.body || '';

    // If audio message, transcribe via Whisper then process as text
    if (!text && msg.type === 'audio' && msg.audio?.id) {
      console.log(`Audio msg from ${from}, id=${msg.audio.id}`);
      const transcribed = await transcribeAudio(msg.audio.id);
      if (transcribed) {
        text = transcribed;
      } else if (from === FABIO) {
        await sendWhatsApp(from, '❌ não consegui transcrever o áudio — tenta de novo ou manda texto');
        continue;
      }
    }

    if (!text) continue;

    if (from === FABIO) {
      // ALWAYS classify first. If reminder → save Asana + ack, don't forward to VPS.
      // This ensures reminders end up in FS Daily PDF (which reads Asana ⚙️ Operações).
      // Conversation → forward to VPS Claw for full brain.
      const classified = await classify(text);
      if (classified.type === 'reminder') {
        const task = await createAsanaTask(classified, text);
        if (task) {
          const taskName = classified.body || text.slice(0, 60);
          await sendWhatsApp(from, `✅ Salvo: "${taskName}"`);
        } else {
          await sendWhatsApp(from, `❌ falha ao criar task no Asana`);
        }
        continue; // do NOT forward to VPS
      }

      // Conversation path — forward to VPS Claw brain
      const payload = {
        from,
        type: msg.type || 'text',
        text,
        audio_id: msg.audio?.id || null,
        image_id: msg.image?.id || null,
        timestamp: Math.floor(Date.now() / 1000),
      };
      const forwarded = await forwardToVPS(payload);
      if (!forwarded) {
        console.log('VPS unreachable, falling back to local Sonnet');
        const reply = await converseWithClaude(text, from);
        await sendWhatsApp(from, `[fallback Netlify, VPS offline] ${reply}`);
      }
      // If forwarded OK, Claw VPS handles reply via Meta API
    } else if (cleaners[from]) {
      const name = cleaners[from];
      console.log(`Cleaner reply from ${name} (${from}): ${text.slice(0, 100)}`);
      if (FABIO) {
        await sendWhatsApp(FABIO, `[${name}] ${text}`);
      }
    } else {
      console.log(`Unknown sender ${from}: ${text.slice(0, 100)}`);
      await sendTelegram(`⚠️ WhatsApp inesperado de ${from}: ${text.slice(0, 200)}`);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
