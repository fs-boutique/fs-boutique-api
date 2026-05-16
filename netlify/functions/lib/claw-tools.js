// claw-tools.js — Anthropic tool definitions + handlers for FS Boutique data.
// Used by whatsapp-router.js conversation path to let Claw answer live questions.

const PROPERTIES = {
  Ibirapuera: '6978bb304e516d00235af973',
  'Op Art': '6978bb2a27f95e0024672482',
  'Moema II': '6981144ddb8d450015392fe0',
  Riviera: '6985f4e2b6a3760015dadd4f',
  'La Quinta': '6985f4f93f7e030015c4dbb1',
};

// Asana FS Boutique projects (per memory: 6 projects)
const ASANA_PROJECTS = {
  'Operações': '1214681681643593',
  Ibirapuera: '1214685117766847',
  'Op Art': '1214683918124025',
  'Moema II': '1214681681425024',
  Riviera: '1214685119993178',
  'La Quinta': '1214681679644424',
};

// ── Guesty auth ───────────────────────────────────────────────────────────────
let _guestyTokenCache = { token: null, expiresAt: 0 };
async function getGuestyToken() {
  if (_guestyTokenCache.token && Date.now() < _guestyTokenCache.expiresAt) {
    return _guestyTokenCache.token;
  }
  const id = process.env.GUESTY_CLIENT_ID;
  const secret = process.env.GUESTY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Guesty creds missing');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'open-api');
  params.append('client_id', id);
  params.append('client_secret', secret);
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`Guesty auth fail ${res.status}`);
  const data = await res.json();
  _guestyTokenCache.token = data.access_token;
  _guestyTokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return data.access_token;
}

function listingIdFor(propertyName) {
  if (!propertyName) return null;
  const key = Object.keys(PROPERTIES).find(
    k => k.toLowerCase() === propertyName.toLowerCase()
  );
  return key ? PROPERTIES[key] : null;
}

// ── Tool: guesty_occupancy ───────────────────────────────────────────────────
async function guestyOccupancy({ property, window_days = 7 }) {
  const token = await getGuestyToken();
  const listing = listingIdFor(property);
  if (property && !listing) return { error: `Unknown property: ${property}` };

  const now = new Date();
  const end = new Date(now.getTime() + window_days * 86400000);
  const startStr = now.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const filters = [
    { field: 'checkIn', operator: '$lt', value: endStr },
    { field: 'checkOut', operator: '$gt', value: startStr },
    { field: 'status', operator: '$in', value: ['confirmed', 'inquiry'] },
  ];
  if (listing) filters.push({ field: 'listingId', operator: '$eq', value: listing });

  const url = `https://open-api.guesty.com/v1/reservations?filters=${encodeURIComponent(JSON.stringify(filters))}&fields=_id%20listingId%20guest.fullName%20checkIn%20checkOut%20status%20guestsCount&limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `Guesty query fail ${res.status}` };
  const data = await res.json();

  const reservations = (data.results || []).map(r => ({
    property: Object.keys(PROPERTIES).find(k => PROPERTIES[k] === r.listingId) || '?',
    guest: r.guest?.fullName || '?',
    checkIn: (r.checkIn || '').slice(0, 10),
    checkOut: (r.checkOut || '').slice(0, 10),
    status: r.status,
    guests: r.guestsCount,
  }));

  // Calculate occupied nights
  let occupiedNights = 0;
  for (const r of reservations) {
    const ci = new Date(r.checkIn) > now ? new Date(r.checkIn) : now;
    const co = new Date(r.checkOut) < end ? new Date(r.checkOut) : end;
    occupiedNights += Math.max(0, Math.ceil((co - ci) / 86400000));
  }
  const propertiesCount = listing ? 1 : Object.keys(PROPERTIES).length;
  const totalNights = window_days * propertiesCount;
  const occupancyPct = totalNights > 0 ? Math.round((occupiedNights / totalNights) * 100) : 0;

  return {
    window: `${startStr} → ${endStr} (${window_days} days)`,
    property: property || 'all properties',
    occupancy_pct: occupancyPct,
    occupied_nights: occupiedNights,
    total_nights: totalNights,
    reservations,
  };
}

// ── Tool: guesty_arrivals ────────────────────────────────────────────────────
async function guestyArrivals({ window_days = 7 }) {
  const token = await getGuestyToken();
  const now = new Date();
  const end = new Date(now.getTime() + window_days * 86400000);
  const filters = [
    { field: 'checkIn', operator: '$gte', value: now.toISOString().slice(0, 10) },
    { field: 'checkIn', operator: '$lte', value: end.toISOString().slice(0, 10) },
    { field: 'status', operator: '$in', value: ['confirmed', 'inquiry'] },
  ];
  const url = `https://open-api.guesty.com/v1/reservations?filters=${encodeURIComponent(JSON.stringify(filters))}&fields=_id%20listingId%20guest.fullName%20checkIn%20checkOut%20status%20guestsCount&limit=30`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `Guesty fail ${res.status}` };
  const data = await res.json();
  const arrivals = (data.results || [])
    .map(r => ({
      property: Object.keys(PROPERTIES).find(k => PROPERTIES[k] === r.listingId) || '?',
      guest: r.guest?.fullName || '?',
      checkIn: (r.checkIn || '').slice(0, 10),
      checkOut: (r.checkOut || '').slice(0, 10),
      guests: r.guestsCount,
      status: r.status,
    }))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  return { window_days, count: arrivals.length, arrivals };
}

// ── Tool: asana_today ────────────────────────────────────────────────────────
async function asanaToday() {
  const token = process.env.ASANA_TOKEN;
  if (!token) return { error: 'Asana token missing' };
  const allTasks = [];
  for (const [projectName, gid] of Object.entries(ASANA_PROJECTS)) {
    const url = `https://app.asana.com/api/1.0/projects/${gid}/tasks?completed_since=now&opt_fields=name,due_at,due_on,gid&limit=50`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const t of data.data || []) {
      allTasks.push({
        project: projectName,
        gid: t.gid,
        name: (t.name || '').trim(),
        due_at: t.due_at || t.due_on || null,
      });
    }
  }
  return { count: allTasks.length, tasks: allTasks };
}

// ── Tool: asana_create_task ─────────────────────────────────────────────────
async function asanaCreateTask({ name, notes = '', project = 'Operações', due_at_iso = null }) {
  const token = process.env.ASANA_TOKEN;
  if (!token) return { error: 'Asana token missing' };
  const projectGid = ASANA_PROJECTS[project] || ASANA_PROJECTS['Operações'];
  const taskData = {
    name: name.slice(0, 250),
    notes: [notes, 'Source: Claw write tool'].filter(Boolean).join('\n'),
    projects: [projectGid],
    workspace: '1214678919136252',
  };
  if (due_at_iso) taskData.due_at = due_at_iso;
  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: taskData }),
  });
  const data = await res.json();
  if (!res.ok) return { error: `Asana create fail ${res.status}`, detail: data };
  return { ok: true, task_gid: data.data.gid, name: data.data.name, permalink: data.data.permalink_url };
}

// ── Tool: asana_complete_task ───────────────────────────────────────────────
async function asanaCompleteTask({ task_gid }) {
  const token = process.env.ASANA_TOKEN;
  if (!token) return { error: 'Asana token missing' };
  if (!task_gid) return { error: 'task_gid required' };
  const res = await fetch(`https://app.asana.com/api/1.0/tasks/${task_gid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { completed: true } }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return { error: `Asana complete fail ${res.status}`, detail: detail.slice(0, 400) };
  }
  return { ok: true, task_gid };
}

// ── Tool: asana_search_tasks ────────────────────────────────────────────────
async function asanaSearchTasks({ query, include_completed = false }) {
  const token = process.env.ASANA_TOKEN;
  if (!token) return { error: 'Asana token missing' };
  if (!query) return { error: 'query required' };
  const projectGid = ASANA_PROJECTS['Operações'];
  const since = include_completed ? '1970-01-01T00:00:00Z' : 'now';
  const url = `https://app.asana.com/api/1.0/projects/${projectGid}/tasks?completed_since=${encodeURIComponent(since)}&opt_fields=name,due_at,completed,gid&limit=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `Asana search fail ${res.status}` };
  const data = await res.json();
  const q = query.toLowerCase();
  const matches = (data.data || [])
    .filter(t => (t.name || '').toLowerCase().includes(q))
    .slice(0, 10)
    .map(t => ({ gid: t.gid, name: t.name, due_at: t.due_at, completed: t.completed }));
  return { count: matches.length, tasks: matches };
}

// ── Tool: whatsapp_send_to_cleaner ──────────────────────────────────────────
// Sends a free-form WhatsApp message to one of the cleaners. Subject to Meta's
// 24h customer-service window — if the cleaner hasn't messaged us in 24h, only
// approved templates work and this will fail with code 131047.
async function whatsappSendToCleaner({ cleaner_name, message }) {
  if (!cleaner_name || !message) return { error: 'cleaner_name + message required' };
  const raw = process.env.CLEANER_WHATSAPPS || '';
  const cleaners = {};
  for (const pair of raw.split(',')) {
    const [num, name] = pair.split(':').map(s => s && s.trim());
    if (num && name) cleaners[num] = name;
  }
  const known = Object.values(cleaners);
  const entry = Object.entries(cleaners).find(
    ([, n]) => n.toLowerCase() === cleaner_name.toLowerCase()
  );
  if (!entry) {
    return { error: `Unknown cleaner: ${cleaner_name}. Known: ${known.join(', ')}` };
  }
  const [phone, name] = entry;
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { error: 'Meta credentials missing' };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: message.slice(0, 4090) },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const errCode = data.error?.code;
    if (errCode === 131047 || errCode === 131026) {
      return { error: `24h window expired — cleaner ${name} has not messaged us recently. Need approved template.`, meta_code: errCode };
    }
    return { error: `WhatsApp send fail ${res.status}`, detail: data.error?.message };
  }
  return { ok: true, sent_to: name, phone, message_id: data.messages?.[0]?.id };
}

// ── Tool: calendar_create_event ─────────────────────────────────────────────
// Posts to Apps Script webhook (Fabio's existing morning-brief Apps Script
// can host the Calendar.createEvent call). Requires GCAL_WEBHOOK_URL env var.
async function calendarCreateEvent({ title, start_iso, end_iso, description = '', calendar_id = 'primary' }) {
  if (!title || !start_iso || !end_iso) return { error: 'title + start_iso + end_iso required' };
  const url = process.env.GCAL_WEBHOOK_URL;
  const secret = process.env.GCAL_WEBHOOK_SECRET;
  if (!url) {
    return {
      error: 'Calendar webhook not configured',
      setup_needed: 'Deploy Apps Script web app + set GCAL_WEBHOOK_URL and GCAL_WEBHOOK_SECRET in Netlify env',
    };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret || '' },
    body: JSON.stringify({ title, start_iso, end_iso, description, calendar_id }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) return { error: `Calendar create fail ${res.status}`, detail: data };
  return { ok: true, event_id: data.event_id, html_link: data.html_link, title };
}

// ── Tool definitions for Anthropic API ───────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    name: 'guesty_occupancy',
    description:
      'Check occupancy and reservations for FS Boutique properties from Guesty. ' +
      'Use when Fabio asks about occupancy, bookings, reservations for a specific property or all properties. ' +
      'Returns occupancy percentage + list of reservations in the window.',
    input_schema: {
      type: 'object',
      properties: {
        property: {
          type: 'string',
          description: 'Property name. One of: Ibirapuera, Op Art, Moema II, Riviera, La Quinta. Omit for all properties.',
          enum: ['Ibirapuera', 'Op Art', 'Moema II', 'Riviera', 'La Quinta'],
        },
        window_days: {
          type: 'number',
          description: 'Number of days from today to look ahead. Default 7.',
        },
      },
    },
  },
  {
    name: 'guesty_arrivals',
    description:
      'List upcoming arrivals across all FS Boutique properties. ' +
      'Use when Fabio asks "who is arriving", "quem chega hoje/amanhã/essa semana", "próximos check-ins".',
    input_schema: {
      type: 'object',
      properties: {
        window_days: {
          type: 'number',
          description: 'Number of days from today to look ahead. Default 7.',
        },
      },
    },
  },
  {
    name: 'asana_today',
    description:
      'List all open Asana tasks across FS Boutique projects (Operações + 5 property projects). ' +
      'Use when Fabio asks "what tasks are open", "o que tenho pra hoje", "lembrar de", "TODOs". ' +
      'Each task includes its `gid` — use that gid with asana_complete_task to mark done.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'asana_create_task',
    description:
      'Create a new Asana task. Use when Fabio asks you to add a task/todo/reminder that does not fit the reminder-classifier path ' +
      '(e.g. detailed multi-part todos, tasks for a specific property project, tasks without a time). ' +
      'Default project is Operações; specify property name to file under that property project.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task title (max 250 chars).' },
        notes: { type: 'string', description: 'Optional task description / details.' },
        project: {
          type: 'string',
          description: 'Project name. Default Operações.',
          enum: ['Operações', 'Ibirapuera', 'Op Art', 'Moema II', 'Riviera', 'La Quinta'],
        },
        due_at_iso: { type: 'string', description: 'Optional ISO 8601 datetime with PST offset for the due time.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'asana_complete_task',
    description:
      'Mark an Asana task complete. Use when Fabio says "já fiz X", "pode apagar o lembrete de X", "completa a task X". ' +
      'You MUST first call asana_search_tasks or asana_today to find the task gid — never invent one. ' +
      'If multiple matches, ask Fabio which one before completing.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Asana task gid (numeric string).' },
      },
      required: ['task_gid'],
    },
  },
  {
    name: 'asana_search_tasks',
    description:
      'Search Asana Operações tasks by partial name match. Use to find a task gid before completing or referencing. ' +
      'Returns up to 10 matches with gid, name, due_at, completed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match in task names (case-insensitive).' },
        include_completed: { type: 'boolean', description: 'Include completed tasks too. Default false.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'whatsapp_send_to_cleaner',
    description:
      'Send a free-form WhatsApp message to a specific cleaner (Ronilde, Rinalva, or Lucia). ' +
      'Use when Fabio asks "manda mensagem pra X dizendo Y" or wants to coordinate a one-off. ' +
      'WARNING: subject to Meta\'s 24h customer-service window — if the cleaner has not messaged the system line recently, ' +
      'this fails with a clear error and you should tell Fabio to wait for an approved template.',
    input_schema: {
      type: 'object',
      properties: {
        cleaner_name: {
          type: 'string',
          description: 'Cleaner first name.',
          enum: ['Ronilde', 'Rinalva', 'Lucia'],
        },
        message: { type: 'string', description: 'Message body in pt-BR (max 4090 chars).' },
      },
      required: ['cleaner_name', 'message'],
    },
  },
  {
    name: 'calendar_create_event',
    description:
      'Create a Google Calendar event. Use when Fabio asks to schedule something with a specific date+time. ' +
      'Both start_iso and end_iso are required (ISO 8601, e.g. "2026-05-20T14:00:00-07:00"). ' +
      'If Fabio only gives one time, default duration is 1h. Requires Apps Script webhook configured.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title.' },
        start_iso: { type: 'string', description: 'ISO 8601 start datetime with timezone offset.' },
        end_iso: { type: 'string', description: 'ISO 8601 end datetime with timezone offset.' },
        description: { type: 'string', description: 'Optional event description / notes.' },
        calendar_id: { type: 'string', description: 'Calendar ID, default "primary".' },
      },
      required: ['title', 'start_iso', 'end_iso'],
    },
  },
];

const TOOL_HANDLERS = {
  guesty_occupancy: guestyOccupancy,
  guesty_arrivals: guestyArrivals,
  asana_today: asanaToday,
  asana_create_task: asanaCreateTask,
  asana_complete_task: asanaCompleteTask,
  asana_search_tasks: asanaSearchTasks,
  whatsapp_send_to_cleaner: whatsappSendToCleaner,
  calendar_create_event: calendarCreateEvent,
};

async function runTool(name, input) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: `Unknown tool: ${name}` };
  try {
    return await handler(input || {});
  } catch (e) {
    console.log(`[tool ${name}] error:`, e.message);
    return { error: e.message };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  runTool,
};
