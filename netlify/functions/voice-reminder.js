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
  // No language hint — auto-detect PT/EN
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

  // Auth
  const expected = process.env.VOICE_REMINDER_TOKEN;
  const provided =
    event.queryStringParameters?.token ||
    event.headers['x-voice-token'] ||
    event.headers['X-Voice-Token'];
  if (!expected || provided !== expected) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // Read body as binary
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf-8');

  if (!body.length) {
    return jsonResponse(400, { error: 'empty body' });
  }

  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || 'audio/m4a';

  // 1. Transcribe
  const t = await whisperTranscribe(body, contentType);
  if (t.error) {
    await sendWhatsApp(`❌ Voice reminder falhou na transcrição: ${t.error}`);
    return jsonResponse(500, t);
  }
  const text = (t.text || '').trim();
  if (!text) {
    await sendWhatsApp(`❌ Voice reminder: áudio veio vazio (sem fala detectada)`);
    return jsonResponse(200, { error: 'empty transcript' });
  }

  // 2. Create Asana task (always — this endpoint is a quick-capture for car/hands-free use)
  const a = await createAsanaTask(text, text);
  if (a.error) {
    await sendWhatsApp(`⚠️ Transcrito mas falhou Asana: "${text}"\n${a.error}`);
    return jsonResponse(500, { transcript: text, asana: a });
  }

  // 3. Send WhatsApp confirmation
  const taskUrl = `https://app.asana.com/0/${process.env.ASANA_PROJECT_OPERACOES}/${a.task.gid}`;
  const confirmMsg = `✅ Salvo: "${text}"\n${taskUrl}`;
  await sendWhatsApp(confirmMsg);

  return jsonResponse(200, {
    ok: true,
    transcript: text,
    task_gid: a.task.gid,
    task_url: taskUrl,
  });
};
