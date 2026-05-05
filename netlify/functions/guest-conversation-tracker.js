// Guest Conversation Tracker
// Subscribes to Guesty message events. As messages flow during a stay, appends
// them to the guest's Notion page. After checkout, runs the conversation through
// Claude Haiku to extract 2-3 memorable personal notes and writes them to the
// "Person Notes" field. The goal is to set FS Boutique apart by remembering each
// guest as a person.
//
// Failure-isolated: if Claude API errors, summarization is skipped. The base
// guest sync (handled by guesty-webhook.js) is unaffected.

const NOTION_DATABASE_ID = '326d1aaf-37d9-8022-b6e0-e21a30b28909';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const TRACKED_EVENTS = [
  'reservation.messageReceived',
  'reservation.messageSent',
  'reservation.checkOut',
  'reservation.updated' // fallback in case checkOut doesn't fire reliably
];

async function notionFindByReservation(token, reservationId) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      filter: { property: 'Reservation ID', rich_text: { equals: reservationId } }
    })
  });
  const data = await res.json();
  return data.results?.[0] || null;
}

async function notionAppendConversationBlock(token, pageId, line) {
  // Append a paragraph block as the conversation log inside the page body.
  return fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      children: [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 1900) } }] }
      }]
    })
  });
}

async function notionGetConversation(token, pageId) {
  // Pull all conversation blocks from the page body to feed into Claude.
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
  });
  if (!res.ok) return '';
  const data = await res.json();
  return (data.results || [])
    .filter(b => b.type === 'paragraph')
    .map(b => (b.paragraph?.rich_text || []).map(t => t.plain_text).join(''))
    .filter(Boolean)
    .join('\n');
}

async function notionWritePersonNotes(token, pageId, notes) {
  return fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      properties: {
        'Person Notes': { rich_text: [{ text: { content: notes.slice(0, 1900) } }] }
      }
    })
  });
}

async function summarizeConversation(claudeKey, guestName, conversation) {
  const prompt = `You are a guest-experience analyst for FS Boutique, a short-term rental brand. Read the conversation log below from a guest's stay and extract 2-3 memorable, useful, personal notes that future communications can reference. Focus on: personal context (family, occupation, hobbies, dietary preferences, special occasions), preferences they expressed, anything the host should remember next time. Keep each note ONE SHORT SENTENCE. Avoid generic remarks. Skip if nothing personal was shared.

Guest: ${guestName}

Conversation log:
${conversation.slice(0, 6000)}

Output format: a bulleted list of 2-3 notes, plain text, no header. If nothing personal was shared, output exactly: NONE`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    console.log('Claude API error', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || '';
  if (text === 'NONE' || !text) return null;
  return text;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const notionToken = process.env.NOTION_TOKEN;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!notionToken) return { statusCode: 200, body: 'NOTION_TOKEN missing — skipping' };

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!TRACKED_EVENTS.includes(payload.event)) {
    return { statusCode: 200, body: 'event not tracked' };
  }

  const r = payload.data;
  if (!r) return { statusCode: 200, body: 'no data' };
  const reservationId = r._id || r.id;
  if (!reservationId) return { statusCode: 200, body: 'no reservation id' };

  // Find the guest's Notion page (created by the main guesty-webhook function).
  // If they don't have a Notion page yet (e.g. form not filled), skip silently.
  const page = await notionFindByReservation(notionToken, reservationId);
  if (!page) {
    console.log('No Notion page yet for reservation', reservationId, '— skipping');
    return { statusCode: 200, body: 'no notion page yet' };
  }

  // === MESSAGE EVENTS: append to conversation log ===
  if (payload.event === 'reservation.messageReceived' || payload.event === 'reservation.messageSent') {
    const direction = payload.event === 'reservation.messageReceived' ? 'GUEST' : 'HOST';
    const text = r.message?.body || r.message?.text || r.body || r.text || '';
    if (!text) return { statusCode: 200, body: 'no message body' };
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = `[${ts}] ${direction}: ${text}`;
    await notionAppendConversationBlock(notionToken, page.id, line);
    console.log('Logged', direction, 'message for', reservationId);
    return { statusCode: 200, body: JSON.stringify({ logged: true, direction }) };
  }

  // === CHECKOUT: extract personal notes ===
  // Trigger the summarization on either reservation.checkOut OR a reservation.updated
  // event where the status flipped to 'checked_out'. Idempotent: skip if Person Notes
  // already populated.
  const isCheckout =
    payload.event === 'reservation.checkOut' ||
    (payload.event === 'reservation.updated' && (r.status === 'checked_out' || r.status === 'closed'));

  if (!isCheckout) {
    return { statusCode: 200, body: 'not a checkout event' };
  }

  // Skip if Person Notes already populated (avoid double-summarization)
  const existingNotes = page.properties?.['Person Notes']?.rich_text || [];
  if (existingNotes.length > 0 && existingNotes[0].plain_text?.trim()) {
    return { statusCode: 200, body: 'Person Notes already filled' };
  }

  if (!claudeKey) {
    console.log('ANTHROPIC_API_KEY missing — skipping summarization');
    return { statusCode: 200, body: 'ANTHROPIC_API_KEY missing' };
  }

  const conversation = await notionGetConversation(notionToken, page.id);
  if (!conversation || conversation.length < 50) {
    return { statusCode: 200, body: 'conversation too short to summarize' };
  }

  const guestName = page.properties?.['Guest Name']?.title?.[0]?.plain_text || 'Guest';
  const notes = await summarizeConversation(claudeKey, guestName, conversation);

  if (notes) {
    await notionWritePersonNotes(notionToken, page.id, notes);
    console.log('Wrote Person Notes for', reservationId);
    return { statusCode: 200, body: JSON.stringify({ summarized: true, notes_length: notes.length }) };
  }
  return { statusCode: 200, body: 'no notable content' };
};
