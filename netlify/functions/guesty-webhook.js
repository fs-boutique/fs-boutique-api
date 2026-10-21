const NOTION_DATABASE_ID = '326d1aaf-37d9-8022-b6e0-e21a30b28909';

const PROPERTY_MAP = {
  'FS I Boutique La Quinta': 'FS I Boutique La Quinta',
  'FS I Boutique Riviera': 'FS I Boutique Riviera',
  'FS I Boutique Moema II': 'FS I Boutique Moema II',
  'FS I Boutique Moema': 'FS I Boutique Moema',
  'FS I Boutique Ibirapuera': 'FS I Boutique Ibirapuera',
};

// Find existing Notion page for this reservation ID
async function findExistingPage(token, reservationId) {
  const res = await fetch('https://api.notion.com/v1/databases/' + NOTION_DATABASE_ID + '/query', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      filter: {
        property: 'Reservation ID',
        rich_text: { equals: reservationId }
      }
    })
  });
  if (!res.ok) {
    throw new Error(`Notion reservation lookup failed (${res.status})`);
  }
  const data = await res.json();
  if (!Array.isArray(data.results)) {
    throw new Error('Notion reservation lookup returned invalid results');
  }
  return data.results[0] || null;
}

async function upsertToNotion(token, guest, reservationId) {
  const properties = {
    'Guest Name': { title: [{ text: { content: guest.name || 'Unknown' } }] },
    'Property': { select: { name: guest.property || '' } },
    'Reservation ID': { rich_text: [{ text: { content: reservationId } }] },
  };

  if (guest.email) properties['Email'] = { email: guest.email };
  if (guest.phone) properties['Phone'] = { phone_number: guest.phone };
  if (guest.checkIn) {
    properties['Stay'] = {
      date: { start: guest.checkIn, end: guest.checkOut || null }
    };
  }
  // Birthday from Check-In form (Guest record top-level OR custom field). Normalized YYYY-MM-DD.
  if (guest.birthday && /^\d{4}-\d{2}-\d{2}/.test(guest.birthday)) {
    properties['Birthday'] = { date: { start: guest.birthday.slice(0, 10) } };
  }
  // Language (preferredLanguage from guest record) → Notion Language select
  if (guest.language) {
    properties['Language'] = { select: { name: String(guest.language).toLowerCase() } };
  }
  // Allergies array from guest record → Notion Allergies multi_select
  if (guest.allergies && guest.allergies.length > 0) {
    properties['Allergies'] = {
      multi_select: guest.allergies.slice(0, 10).map(a => ({ name: String(a).slice(0, 100) })),
    };
  }
  // Adults from reservation guestsCount → Notion Adults number
  if (typeof guest.adults === 'number' && guest.adults > 0) {
    properties['Adults'] = { number: guest.adults };
  }
  if (guest.checkOut) {
    properties['Check-out Date'] = { date: { start: guest.checkOut } };
  }

  const existing = await findExistingPage(token, reservationId);

  if (existing) {
    const existingEmail = existing.properties?.Email?.email;
    if (!guest.email && existingEmail) {
      delete properties['Email'];
    }
    const res = await fetch('https://api.notion.com/v1/pages/' + existing.id, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ properties })
    });
    return res.ok;
  } else {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties
      })
    });
    return res.ok;
  }
}

// FS Boutique rule (2026-05-13, clarified):
// Sync everyone with at minimum email OR phone. Don't gate on missing fields —
// MORE contacts in the database = better. But report missing fields so Fabio
// can chase the guest for the gap.
// Always skip Fabio's own emails. Always skip OTA proxy emails (they don't reach the guest).
const FABIO_EMAILS = ['fabio@fsboutique.co', 'fabiotennis@icloud.com'];
function isProxyEmail(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith('guest.booking.com') || e.endsWith('guest.airbnb.com') || e.includes('@airbnb');
}
function guestCompleteness(guest) {
  const missing = [];
  if (!guest.name || guest.name.trim().split(/\s+/).length < 2) missing.push('name');
  if (!guest.phone) missing.push('phone');
  if (!guest.email || isProxyEmail(guest.email)) missing.push('email');
  if (!guest.birthday) missing.push('birthday');
  return { missing };
}
// Only block sync if (a) it's Fabio's own contact, or (b) we have NO useful contact channel
// (no real email AND no phone). Everything else syncs, with missing fields flagged.
function isCompleteGuest(guest) {
  if (guest.email && FABIO_EMAILS.includes(guest.email.toLowerCase())) return false;
  const hasUsableEmail = guest.email && !isProxyEmail(guest.email);
  const hasPhone = !!guest.phone;
  return hasUsableEmail || hasPhone;
}

// Send WhatsApp alert to Fabio via Meta Cloud API when a guest is synced with
// missing fields. Fires only on FIRST sync (new Notion page) to avoid spamming
// on every reservation.updated.
//
// PRIMARY: Meta Cloud API (Claw WhatsApp) — uses META_ACCESS_TOKEN +
//   META_PHONE_NUMBER_ID + FABIO_WHATSAPP env vars.
// FALLBACK: Telegram (legacy FS Manager bot) — kept commented for emergency
//   only; the bot 8632680202 was killed 2026-05-21 so this path is dead. Do not
//   re-enable without setting a working TELEGRAM_BOT_TOKEN.
async function flagMissingFields(guest, missing) {
  if (!missing.length) return false;
  const checkIn = guest.checkIn ? guest.checkIn.split('T')[0].split('-').reverse().slice(0, 2).join('/') : '?';
  const text = `🚩 Hóspede ${guest.name} (${guest.property || 'sem propriedade'}, check-in ${checkIn}) faltando: ${missing.join(', ')} — preciso pedir pra ele/ela.`;

  // Meta Cloud API (primary)
  const metaToken = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const fabioWa = process.env.FABIO_WHATSAPP || '19499297173';
  const apiVersion = process.env.META_API_VERSION || 'v21.0';
  if (metaToken && phoneNumberId) {
    try {
      const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${metaToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: fabioWa,
          type: 'text',
          text: { body: text }
        })
      });
      console.log('Meta WhatsApp flag', guest.name, missing.join(','), '→', res.status);
      if (res.ok) return true;
      const errBody = await res.text();
      console.log('Meta WhatsApp flag non-200 body:', errBody.slice(0, 300));
    } catch (e) {
      console.log('Meta WhatsApp flag failed', e.message);
    }
  } else {
    console.log('Meta WhatsApp flag skipped — missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID');
  }

  // Telegram fallback (DEAD — FS Manager bot 8632680202 killed 2026-05-21).
  // Commented out intentionally. Re-enable only if a new bot token is set.
  // const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  // const tgChat = process.env.TELEGRAM_CHAT_ID;
  // if (tgToken && tgChat) {
  //   try {
  //     const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'HTML' })
  //     });
  //     console.log('Telegram flag (fallback)', guest.name, '→', res.status);
  //     return res.ok;
  //   } catch (e) {
  //     console.log('Telegram flag fallback failed', e.message);
  //   }
  // }

  return false;
}

// Upsert contact to Brevo — only when guest record is complete
async function upsertToBrevo(apiKey, guest) {
  if (!isCompleteGuest(guest)) {
    console.log('Brevo: skipping incomplete guest', { email: guest.email, phone: guest.phone, birthday: guest.birthday });
    return false;
  }

  const nameParts = guest.name.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const body = {
    email: guest.email,
    updateEnabled: true,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME: lastName,
      SMS: guest.phone,
      PROPERTY: guest.property || '',
      LAST_CHECKIN: guest.checkIn || '',
      LAST_CHECKOUT: guest.checkOut || ''
    },
    listIds: [2]
  };
  if (guest.birthday) body.attributes.BIRTHDAY = guest.birthday;

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log('Brevo upsert', guest.email, '→', res.status);
  return res.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Log every incoming webhook for later diagnosis of intermittent Guesty delivery.
  console.log('[guesty-webhook] incoming POST', {
    bodyLen: (event.body || '').length,
    contentType: event.headers['content-type'] || event.headers['Content-Type'] || '',
    userAgent: event.headers['user-agent'] || event.headers['User-Agent'] || '',
  });

  const notionToken = process.env.NOTION_TOKEN;
  const brevoKey = process.env.BREVO_API_KEY;

  if (!notionToken) {
    return { statusCode: 500, body: 'NOTION_TOKEN not set' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    console.log('[guesty-webhook] invalid JSON');
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Log the event shape — captures Guesty's delivery details for offline analysis.
  console.log('[guesty-webhook] event=', payload.event, 'reservationId=', payload.data?._id,
              'status=', payload.data?.status,
              'source=', payload.data?.source,
              'platform=', payload.data?.integration?.platform,
              'hasGuestEmail=', !!(payload.data?.guest?.email),
              'hasGuestPhone=', !!(payload.data?.guest?.phone));

  if (!['reservation.new', 'reservation.updated'].includes(payload.event)) {
    console.log('[guesty-webhook] ignoring event type', payload.event);
    return { statusCode: 200, body: 'ignored' };
  }

  const r = payload.data;
  if (!r) return { statusCode: 200, body: 'no data' };

  const reservationId = r._id || r.id;
  if (!reservationId) return { statusCode: 200, body: 'no reservation id' };

  // Extract personal email + birthday from custom fields. Webhook payload may not include
  // custom fields inline, so also fall back to fetching the guest object directly from Guesty.
  const customFields = r.customFields || r.guest?.customFields || [];
  let personalEmail = null;
  let birthday = null;
  for (const f of customFields) {
    const val = f.value || f.fieldValue || '';
    const name = (f.fieldName || f.name || '').toLowerCase();
    if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      if (!personalEmail || name.includes('email') || name.includes('personal')) personalEmail = val;
    }
    if (val && (name.includes('birth') || name.includes('dob') || name.includes('aniversário'))) {
      // Normalize to YYYY-MM-DD if possible
      const m = String(val).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (m) birthday = m[1] ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : `${m[6]}-${m[5].padStart(2,'0')}-${m[4].padStart(2,'0')}`;
      else birthday = val;
    }
  }

  // ALWAYS fetch full guest record from Guesty. Top-level fields like `birthday`,
  // `preferredLanguage`, `allergies` are NOT in customFields — they're top-level
  // on the guest object and only available via /v1/guests/{id}.
  let fullGuest = r.guest || {};
  if (fullGuest._id) {
    try {
      const guestyToken = await getGuestyToken();
      if (guestyToken) {
        const gres = await fetch(`https://open-api.guesty.com/v1/guests/${fullGuest._id}`, {
          headers: { 'Authorization': `Bearer ${guestyToken}` }
        });
        if (gres.ok) {
          const gdata = await gres.json();
          fullGuest = { ...fullGuest, ...gdata };
          // Re-scan custom fields from full guest record
          for (const f of (gdata.customFields || [])) {
            const val = f.value || f.fieldValue || '';
            const name = (f.fieldName || f.name || '').toLowerCase();
            if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) && (!personalEmail || name.includes('email'))) personalEmail = val;
            if (val && (name.includes('birth') || name.includes('dob') || name.includes('aniversário'))) birthday = birthday || val;
          }
        }
      }
    } catch (e) {
      console.log('Guesty guest fetch failed', e.message);
    }
  }

  // Top-level birthday on guest (NOT in customFields). Common path for Check-In form data.
  if (!birthday && fullGuest.birthday) {
    const raw = String(fullGuest.birthday);
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) birthday = `${m[1]}-${m[2]}-${m[3]}`;
  }

  const guestEmail = personalEmail || fullGuest.email || null;
  const guestPhone = fullGuest.phone || (fullGuest.phones && fullGuest.phones[0]) || null;
  const language = fullGuest.preferredLanguage || null;
  const allergies = Array.isArray(fullGuest.allergies) ? fullGuest.allergies.filter(Boolean) : [];
  const adultsCount = r.guestsCount || null;

  const listingName = r.listing?.nickname || r.listing?.title || '';
  const mappedProperty = Object.entries(PROPERTY_MAP).find(([key]) =>
    listingName.toLowerCase().includes(key.toLowerCase().replace('fs i boutique ', ''))
  )?.[1] || listingName;

  const guest = {
    name: fullGuest.fullName || ((fullGuest.firstName || '') + ' ' + (fullGuest.lastName || '')).trim(),
    email: guestEmail,
    phone: guestPhone,
    birthday: birthday,
    language: language,
    allergies: allergies,
    adults: adultsCount,
    checkIn: r.checkIn ? r.checkIn.split('T')[0] : null,
    checkOut: r.checkOut ? r.checkOut.split('T')[0] : null,
    property: mappedProperty,
  };

  console.log('Webhook fired', payload.event, 'guest:', { name: guest.name, email: guest.email, phone: guest.phone, birthday: guest.birthday });

  if (!guest.name || !guest.checkIn) {
    return { statusCode: 200, body: 'insufficient data' };
  }

  try {
    if (isCompleteGuest(guest)) {
      const wasExisting = !!(await findExistingPage(notionToken, reservationId));
      if (!(await upsertToNotion(notionToken, guest, reservationId))) {
        throw new Error('Notion sync failed');
      }
      if (brevoKey && !(await upsertToBrevo(brevoKey, guest))) {
        throw new Error('Brevo sync failed');
      }

      // Flag missing fields on first sync only (avoids spam on reservation.updated)
      const { missing } = guestCompleteness(guest);
      if (!wasExisting && missing.length > 0) {
        await flagMissingFields(guest, missing);
      }

      return { statusCode: 200, body: JSON.stringify({ success: true, synced: true, email: guest.email, missing }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, synced: false, reason: 'no usable contact channel (neither email nor phone)' }) };
  } catch (err) {
    console.log('Sync error', err.message);
    return { statusCode: 500, body: err.message };
  }
};

// Get Guesty access token using client credentials
async function getGuestyToken() {
  const cid = process.env.GUESTY_CLIENT_ID;
  const cs = process.env.GUESTY_CLIENT_SECRET;
  if (!cid || !cs) return null;
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&scope=open-api&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(cs)}`
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token;
}
