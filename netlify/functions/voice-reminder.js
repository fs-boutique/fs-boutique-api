// voice-reminder.js — iPhone Shortcut endpoint.
//
// Flow: iPhone Shortcut records audio → POSTs binary body here → Whisper transcribes
// (auto-detects PT/EN) → Asana task created → WhatsApp confirmation to Fabio.
//
// Auth: shared token in ?token= query OR X-Voice-Token header.
// Body: raw binary audio (m4a/mp3/wav/ogg) OR multipart/form-data with "audio" field.

const FABIO_WHATSAPP = '19499297173';
const WORKSPACE_ID = '1214678919136252';

function jsonResponse(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

async function whisperTranscribe(audioBuffer, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: 'OPENAI_API_KEY missing' };
  const ext = mime.includes('mp4') ? 'm4a'
    : mime.includes('mpeg') ? 'mp3'
    : mime.includes('wav') ? 'wav'
    : mime.includes('ogg') ? 'ogg'
    : 'm4a';
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: mime }), `audio.${ext}`);
  formData.append('model', 'whisper-1');
  // Force pt to prevent auto-detect picking random languages. Add bilingual
  // prompt so PT+EN code-switching transcribes correctly.
  formData.append('language', 'pt');
  formData.append('prompt', 'Fabio fala português brasileiro com palavras inglesas misturadas. Frases típicas: "lembra de tomar café", "lembra de ligar pro João", "anota: comprar leite", "vou ao meeting às 3", "occupancy do Moema essa semana", "rate do Booking", "cleaner amanhã na Riviera". Palavras EN comuns: meeting, checkout, check-in, booking, occupancy, rate, listing, Airbnb, Booking, dashboard, owner, host, guest, cleaner, Asana, WhatsApp, Claw, Claude. SEMPRE escreva "lembra" (não "lembro") quando ele pede pra ser lembrado.');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) return { error: 'whisper failed', data };
  return { text: data.text || '' };
}

async function createAsanaTask(name, originalTranscript) {
  const token = process.env.ASANA_TOKEN;
  const project = process.env.ASANA_PROJECT_OPERACOES;
  if (!token || !project) return { error: 'Asana creds missing' };
  const notes = [
    `Source: voice shortcut (iPhone)`,
    `Transcript: "${originalTranscript}"`,
    `Captured: ${new Date().toISOString()}`,
  ].join('\n');
  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        name: name.slice(0, 250),
        notes,
        projects: [project],
        workspace: WORKSPACE_ID,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) return { error: 'asana create failed', data };
  return { task: data.data };
}

async function sendWhatsApp(text) {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!metaToken || !phoneId) return { error: 'Meta creds missing' };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${metaToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: FABIO_WHATSAPP,
      type: 'text',
      text: { body: text.slice(0, 4090) },
    }),
  });
  const data = await res.json();
  if (!res.ok) return { error: 'whatsapp send failed', data };
  return { ok: true, data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'POST only' });
  }

  // Debug log: capture incoming request shape so we can diagnose iOS Shortcut payloads
  // without iPhone debugger access.
  console.log('voice-reminder request:', JSON.stringify({
    method: event.httpMethod,
    headers: event.headers,
    isBase64Encoded: event.isBase64Encoded,
    bodyLen: event.body?.length || 0,
    bodyPreview: (event.body || '').slice(0, 200),
  }));

  // Auth
  const expected = process.env.VOICE_REMINDER_TOKEN;
  const provided =
    event.queryStringParameters?.token ||
    event.headers['x-voice-token'] ||
    event.headers['X-Voice-Token'];
  if (!expected || provided !== expected) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // Three body modes:
  // 1. JSON with {text: "..."} — used by Dictate Text iPhone Shortcut (no audio).
  // 2. JSON with {audio_base64: "..."} — iPhone Shortcut with binary audio in base64.
  // 3. Raw binary audio in body — curl/test.
  const contentType =
    event.headers['content-type'] || event.headers['Content-Type'] || 'audio/m4a';

  let text;
  let body;
  let mime;
  if (contentType.includes('application/json')) {
    let parsed;
    try {
      parsed = JSON.parse(event.body || '{}');
    } catch (e) {
      return jsonResponse(400, { error: 'invalid JSON' });
    }
    if (parsed.text && parsed.text.trim()) {
      // Mode 1: text directly (skip Whisper)
      text = parsed.text.trim();
    } else if (parsed.audio_base64) {
      // Mode 2: base64 audio
      body = Buffer.from(parsed.audio_base64, 'base64');
      mime = parsed.mime || 'audio/m4a';
    } else {
      return jsonResponse(400, { error: 'missing text or audio_base64' });
    }
  } else {
    // Mode 3: raw binary audio
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf-8');
    mime = contentType;
  }

  // If body present and no text yet, transcribe via Whisper.
  if (!text) {
    if (!body || !body.length) {
      return jsonResponse(400, { error: 'empty body' });
    }
  }

  // 1. Transcribe (only if we have audio and no text yet)
  if (!text) {
    const t = await whisperTranscribe(body, mime || contentType);
    if (t.error) {
      await sendWhatsApp(`❌ Voice reminder falhou na transcrição: ${t.error}`);
      return jsonResponse(500, t);
    }
    text = (t.text || '').trim();
    if (!text) {
      await sendWhatsApp(`❌ Voice reminder: áudio veio vazio (sem fala detectada)`);
      return jsonResponse(200, { error: 'empty transcript' });
    }
  }

  // 2. Create Asana task (always — this endpoint is a quick-capture for car/hands-free use)
  const a = await createAsanaTask(text, text);
  if (a.error) {
    await sendWhatsApp(`⚠️ Transcrito mas falhou Asana: "${text}"\n${a.error}`);
    return jsonResponse(500, { transcript: text, asana: a });
  }

  // 3. Send WhatsApp confirmation (no Asana link — Fabio hates the long URL,
  //    and FS Daily PDF already lists these tasks every morning anyway).
  await sendWhatsApp(`✅ Salvo: "${text}"`);

  return jsonResponse(200, {
    ok: true,
    transcript: text,
    task_gid: a.task.gid,
  });
};
