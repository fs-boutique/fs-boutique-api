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
const { TOOL_DEFINITIONS, runTool } = require('./lib/claw-tools');

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
// Netlify injects SITE_ID + NETLIFY_FUNCTIONS_TOKEN into every Function automatically,
// but @netlify/blobs v8 does not pick them up implicitly. We pass them explicitly.
let blobsModule = null;
async function getMemoryStore() {
  if (!blobsModule) {
    try { blobsModule = await import('@netlify/blobs'); }
    catch (e) { console.log('Blobs unavailable:', e.message); return null; }
  }
  const siteID = process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN; // Netlify Personal Access Token, scope: account-level
  if (!siteID || !token) {
    console.log('getStore: missing SITE_ID or BLOBS_TOKEN env');
    return null;
  }
  try {
    return blobsModule.getStore({ name: 'claw-conversation', siteID, token });
  } catch (e) {
    console.log('getStore fail:', e.message);
    return null;
  }
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

// Haiku classifier — reminder vs conversation, with optional due_at extraction
async function classify(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { type: 'conversation' };
  // Fabio is in PST (America/Los_Angeles). Provide current local datetime for relative
  // time parsing ("amanhã às 4am", "em 30 min", "sexta às 10h").
  const now = new Date();
  const fabioTZ = 'America/Los_Angeles';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: fabioTZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const nowISO = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${(parts.timeZoneName || '').replace('GMT', '')}`;
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(nowISO).getDay()];

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
        max_tokens: 384,
        system:
          'You classify WhatsApp messages Fabio sends to his assistant Claw.\n' +
          `Current Fabio local time: ${nowISO} (${dayName}, PST, America/Los_Angeles).\n\n` +
          'DEFAULT to "conversation". Only return "reminder" when there is an EXPLICIT reminder/todo keyword.\n\n' +
          '"reminder" — ONLY when message starts with or clearly contains:\n' +
          '- "lembrar de ...", "lembra de ..."\n' +
          '- "remember to ...", "remind me to ..."\n' +
          '- "TODO: ...", "task: ..."\n' +
          '- "preciso lembrar de ...", "anota: ..."\n\n' +
          '"conversation" — EVERYTHING ELSE: statements, questions, discussions, action requests.\n\n' +
          'When in doubt → "conversation".\n\n' +
          'IF type=reminder, also extract optional time:\n' +
          '- due_at_iso: ISO 8601 datetime with PST offset (e.g. "2026-05-16T04:00:00-07:00") IF user mentioned a specific time, else null.\n' +
          '- due_at_str: human-readable PT description (e.g. "amanhã 04:00 PST", "em 30 min", "sexta 10h") or null.\n' +
          '- Examples: "lembra amanhã às 4am" → due_at_iso=next day 04:00, due_at_str="amanhã 04:00 PST".\n' +
          '  "lembra em 30 min" → due_at_iso=now+30min ISO, due_at_str="em 30 min".\n' +
          '  "lembra de comprar leite" → due_at_iso=null, due_at_str=null (no time given).\n' +
          '  "lembra hoje às 11pm" → today 23:00 PST (if not yet past), else tomorrow.\n\n' +
          'Reply ONLY with single-line JSON: {"type":"reminder|conversation","body":"clean task text","property":"Ibirapuera|Op Art|Moema II|Riviera|La Quinta|null","due_at_iso":"ISO datetime or null","due_at_str":"PT desc or null"}.',
        messages: [{ role: 'user', content: text }],
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) { console.log('Classify fail', e.message); }
  return { type: 'conversation' };
}

// Sonnet conversational reply WITH TOOL USE. Loops until Claude stops calling tools.
// Returns final text reply. Tools defined in lib/claw-tools.js (Guesty/Asana queries).
async function callClaudeWithTools(key, systemPrompt, messages, maxToolIterations = 10) {
  const models = ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

  // Mutable copy of messages for tool-use loop
  const convo = messages.slice();

  let lastError = null;
  let iteration = 0;
  let usedModel = models[0];

  while (iteration < maxToolIterations) {
    iteration++;
    let response = null;
    // Try each model with retry on overload
    for (const model of models) {
      let attempted = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        attempted = true;
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1024,
              system: systemPrompt,
              // Anthropic native server-side web_search (no client-side handler needed).
              // Mixed with client tools from claw-tools.js. Results stream back in the
              // same response so my callClaudeWithTools loop doesn't need a special case.
              tools: [
                ...TOOL_DEFINITIONS,
                { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
              ],
              messages: convo,
            }),
          });
          const data = await res.json();
          if (data.content && Array.isArray(data.content) && data.content.length > 0) {
            usedModel = model;
            response = data;
            break;
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
      if (response) break;
    }

    if (!response) {
      return `⚠️ Anthropic API instável agora (${lastError}). Manda de novo em 30s.`;
    }

    // Process response: check stop_reason
    if (response.stop_reason === 'tool_use') {
      // Find all tool_use blocks; append assistant turn + execute each tool
      convo.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 8000),
          });
        }
      }
      convo.push({ role: 'user', content: toolResults });
      continue; // next iteration to let Claude synthesize
    }

    // stop_reason === 'end_turn' (or 'max_tokens' / other) — extract text
    const textBlocks = response.content.filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.text).join('\n').trim();
    if (usedModel !== 'claude-sonnet-4-6') console.log(`Used fallback model: ${usedModel}`);
    return text || `⚠️ resposta vazia do modelo.`;
  }

  return `⚠️ Tool loop hit ${maxToolIterations} iterations sem chegar numa resposta final. Bug do servidor, não tua mensagem. Tenta de novo.`;
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
    'Reply short, direct, no preamble. Match the language Fabio writes in (PT-BR default; switch to EN only if he writes pure English). ' +
    'You have memory of recent messages in this thread (last ~12h).\n\n' +
    'TOOLS available — USE THEM when Fabio asks about live data OR asks for an action:\n' +
    '- guesty_occupancy(property, window_days): occupancy % + reservation list.\n' +
    '- guesty_arrivals(window_days): who is checking in.\n' +
    '- asana_today(): all open tasks across 6 FS Boutique projects (each result includes gid).\n' +
    '- asana_create_task(name, notes?, project?, due_at_iso?): create a new task. Use for detailed/multi-part todos or tasks without explicit time. Reminders WITH explicit time should still go through the classifier path (Fabio just says "lembra de X amanhã") — only use this tool when Sonnet itself needs to add a task as part of a tool sequence.\n' +
    '- asana_complete_task(task_gid): mark a task done. Use for "já fiz X", "apaga o lembrete de X", "completa a task X". ALWAYS call asana_search_tasks or asana_today FIRST to get the real gid — never invent one. If multiple matches, ask Fabio which one.\n' +
    '- asana_search_tasks(query, include_completed?): find tasks by partial name match. Returns up to 10 with gid.\n' +
    '- recall_memory(query, limit?): search Fabio\'s persistent memory dir (claude-memory git repo) by keyword. Returns matching file names + descriptions. Use whenever Fabio references a past decision, property fact, person, preference, SOP, credential location, or anything that should be persistent across sessions. **ALWAYS call recall_memory BEFORE suggesting Fabio create a new memory file. The file you think is missing usually already exists.**\n' +
    '- read_memory_file(filename): fetch the full content of a specific memory file. Use after recall_memory returns matches and you need the actual content.\n' +
    '- web_search(query): live web search via Anthropic. Use for current events, prices, addresses, business hours, anything that may have changed since training. Max 3 uses per turn.\n' +
    '- web_fetch(url, max_chars?): fetch a specific URL and return cleaned text. Use to follow up on a web_search result, read a status page, or check an API response.\n' +
    '- mailbox_send(to, text, priority?): send a message to the other Claudes (laptop Claude Code, iMac Claude Garage). Use when Fabio says "tell my laptop Claude X" or "remind iMac Claude Y". priority="high" also pings Fabio\'s Telegram.\n' +
    '- mailbox_check(): check unread messages from the other Claudes. Use proactively when Fabio asks "any updates from my other Claudes?" or "what did Garage do today?".\n' +
    '- create_calendar_event(title, start_iso, end_iso, attendees?, ...): create a Google Calendar event on Fabio\'s default cal. Times need ISO 8601 with TZ (PST=-07:00 summer, -08:00 winter). When Fabio mentions a person by first name (Samantha, James, Nathan, etc.) and you need their email, FIRST search Gmail with `from:firstname OR to:firstname` or recall_memory for `reference_expert_contacts` BEFORE asking Fabio for the email. Only ask Fabio if all lookups fail. If event is solo (no attendee mentioned), create WITHOUT attendees, do not ask.\n' +
    '- search_gmail(query, max_results?): search Fabio\'s Gmail with Gmail syntax (from:X, newer_than:7d, etc). Also use proactively to find email addresses for people mentioned by first name in calendar/draft requests.\n' +
    '- create_gmail_draft(to, subject, body, ...): create Gmail DRAFT (does not send). Optionally reply on a thread.\n' +
    '- search_drive(query, max_results?): full-text + name search in Fabio\'s Google Drive.\n' +
    '- tavily_search(query): tuned-for-AI web search. Better than web_search for structured questions; returns clean title+url+snippet plus AI answer. Prefer over web_search.\n' +
    '- tavily_extract(url): clean structured extraction from a URL. Handles JS-rendered pages better than web_fetch.\n' +
    '- pricelabs_listings: list FS Boutique properties on PriceLabs with base/min/max prices, market, push status. Use for pricing config questions.\n' +
    '- asana_add_comment(task_gid, text): add a comment to an existing Asana task. ALWAYS asana_search_tasks first to get the gid.\n' +
    '- asana_list_projects: list the 6 FS Boutique Asana projects with gids.\n' +
    '- whatsapp_send_to_cleaner(cleaner_name, message): send a free-form WhatsApp to Ronilde/Rinalva/Lucia. Subject to Meta 24h window, if it fails with 24h-window error, tell Fabio.\n\n' +
    'CRITICAL RULES:\n' +
    '- No emojis unless Fabio uses them first.\n' +
    '- Never say "padrão boutique", "[word] boutique", "FS Boutique standard" — strict brand rule.\n' +
    '- Use ✅ / ⚠️ / ❌ for status if needed (green check, yellow warning triangle, red X).\n' +
    '- Properties: Ibirapuera, Op Art (Moema), Moema II, Riviera, La Quinta. Under construction: 25h, Ritmo Itaim.\n' +
    '- Writes ARE enabled now (Asana, WhatsApp to cleaners, Calendar). Don\'t say "não tenho writes habilitados". If a write tool fails, surface the error briefly.\n' +
    '- For destructive actions (asana_complete_task, whatsapp_send_to_cleaner): confirm with Fabio in one short line BEFORE calling the tool if there is ANY ambiguity. If he explicitly said "manda" or "completa" with clear target, just do it and report.\n' +
    '- After running tools, summarize the data Fabio needs in 1-3 lines. Don\'t dump raw JSON. Don\'t list 20 items — pick top 5 or aggregate.\n' +
    'Keep replies under 4 lines unless Fabio asks for more detail.';

  const reply = await callClaudeWithTools(key, systemPrompt, messages);

  // Always persist the user's message — even on transient API errors. Otherwise
  // back-to-back messages lose context (the "Contexto perdido" bug from 2026-05-16
  // when an upstream Claude call returned an empty/overloaded response between turns).
  const ts = Date.now();
  history.push({ role: 'user', content: text, ts });
  const replyValid = reply && !reply.startsWith('⚠️ Anthropic API instável') && !reply.startsWith('⚠️ Tool loop hit limit');
  if (replyValid) {
    history.push({ role: 'assistant', content: reply, ts });
  }
  await saveHistory(phone, history);

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
    formData.append('prompt', 'Fabio fala português brasileiro com palavras inglesas misturadas. Frases típicas: "lembra de tomar café", "lembra de ligar pro João", "anota: comprar leite", "vou ao meeting às 3", "occupancy do Moema essa semana", "rate do Booking", "cleaner amanhã na Riviera". Palavras EN comuns: meeting, checkout, check-in, booking, occupancy, rate, listing, Airbnb, Booking, dashboard, owner, host, guest, cleaner, Asana, WhatsApp, Claw, Claude. SEMPRE escreva "lembra" (não "lembro") quando ele pede pra ser lembrado.');
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
    parsed.due_at_str ? `Reminder time: ${parsed.due_at_str}` : null,
    `Source: Claw via WhatsApp (Meta Cloud API)`,
    `Captured: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
  const taskData = { name, notes, projects: [project], workspace: '1214678919136252' };
  // If classifier extracted a specific time, set due_at (Asana ISO 8601).
  // Scheduler on VPS polls Asana every minute and pings WhatsApp when due_at matches.
  if (parsed.due_at_iso) taskData.due_at = parsed.due_at_iso;
  console.log('[asana] POST request body:', JSON.stringify(taskData).slice(0, 500));
  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: taskData })
  });
  const data = await res.json();
  console.log('[asana] response status:', res.status, 'body:', JSON.stringify(data).slice(0, 800));
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
      console.log('[classify] input:', text.slice(0, 100), 'output:', JSON.stringify(classified));
      if (classified.type === 'reminder') {
        const task = await createAsanaTask(classified, text);
        let confirmMsg;
        if (task) {
          const taskName = classified.body || text.slice(0, 60);
          confirmMsg = `✅ Salvo: "${taskName}"`;
          if (classified.due_at_str) {
            confirmMsg += `, vou te avisar ${classified.due_at_str}`;
          }
        } else {
          confirmMsg = `❌ falha ao criar task no Asana`;
        }
        await sendWhatsApp(from, confirmMsg);

        // Persist the reminder turn into conversation memory so subsequent
        // conversation messages have context. Without this, "manda detalhe
        // do evento" right after a "lembra de jantar com Bruna" returns
        // "não recebi a mensagem anterior". Tag the user content so Sonnet
        // knows it was the reminder path.
        const history = await loadHistory(from);
        const ts = Date.now();
        history.push({ role: 'user', content: text, ts });
        history.push({ role: 'assistant', content: confirmMsg, ts });
        await saveHistory(from, history);

        continue; // do NOT forward to VPS
      }

      // Conversation path — Netlify v3 Claw (Sonnet + Guesty/Asana tools) as PRIMARY.
      // VPS Claw kept as fallback if Anthropic API fails entirely.
      // Reason: v3 has live tool access (occupancy, arrivals, tasks). VPS only reads
      // cached memory, leading to stale answers like "sync parou 22/04" when queried
      // about current state.
      const reply = await converseWithClaude(text, from);
      if (reply && !reply.startsWith('⚠️ Anthropic API instável')) {
        await sendWhatsApp(from, reply);
      } else {
        // Last-resort fallback: forward to VPS Claw
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
          await sendWhatsApp(from, reply || '⚠️ Sistema indisponível agora. Tenta de novo em 30s.');
        }
      }
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
