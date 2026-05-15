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
    const url = `https://app.asana.com/api/1.0/projects/${gid}/tasks?completed_since=now&opt_fields=name,due_at,due_on&limit=50`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const t of data.data || []) {
      allTasks.push({
        project: projectName,
        name: (t.name || '').trim(),
        due_at: t.due_at || t.due_on || null,
      });
    }
  }
  return { count: allTasks.length, tasks: allTasks };
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
      'Use when Fabio asks "what tasks are open", "o que tenho pra hoje", "lembrar de", "TODOs".',
    input_schema: { type: 'object', properties: {} },
  },
];

const TOOL_HANDLERS = {
  guesty_occupancy: guestyOccupancy,
  guesty_arrivals: guestyArrivals,
  asana_today: asanaToday,
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
