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
  const data = await res.json();
  return data.results?.[0] || null;
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

// Validate that we have a complete guest record per FS Boutique rule (2026-05-05):
// must have real personal email + phone + birthday. No proxies, no Fabio.
const FABIO_EMAILS = ['fabio@fsboutique.co', 'fabiotennis@icloud.com'];
function isCompleteGuest(guest) {
  if (!guest.email || !guest.phone) return false;
  const email = guest.email.toLowerCase();
  if (FABIO_EMAILS.includes(email)) return false; // never sync Fabio's own contact
  if (email.endsWith('guest.booking.com')) return false;
  if (email.endsWith('guest.airbnb.com')) return false;
  if (email.includes('@airbnb')) return false;
  // Birthday is now required per the new rule. Skip silently if missing — guest hasn't
  // completed the form yet. Webhook will fire again on the next reservation.updated.
  if (!guest.birthday) return false;
  return true;
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

  const notionToken = process.env.NOTION_TOKEN;
  const brevoKey = process.env.BREVO_API_KEY;

  if (!notionToken) {
    return { statusCode: 500, body: 'NOTION_TOKEN not set' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!['reservation.new', 'reservation.updated'].includes(payload.event)) {
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

  // If webhook payload is thin, fetch the full guest record from Guesty directly
  let fullGuest = r.guest || {};
  if (!personalEmail && !fullGuest.email && fullGuest._id) {
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

  const guestEmail = personalEmail || fullGuest.email || null;
  const guestPhone = fullGuest.phone || (fullGuest.phones && fullGuest.phones[0]) || null;

  const listingName = r.listing?.nickname || r.listing?.title || '';
  const mappedProperty = Object.entries(PROPERTY_MAP).find(([key]) =>
    listingName.toLowerCase().includes(key.toLowerCase().replace('fs i boutique ', ''))
  )?.[1] || listingName;

  const guest = {
    name: fullGuest.fullName || ((fullGuest.firstName || '') + ' ' + (fullGuest.lastName || '')).trim(),
    email: guestEmail,
    phone: guestPhone,
    birthday: birthday,
    checkIn: r.checkIn ? r.checkIn.split('T')[0] : null,
    checkOut: r.checkOut ? r.checkOut.split('T')[0] : null,
    property: mappedProperty,
  };

  console.log('Webhook fired', payload.event, 'guest:', { name: guest.name, email: guest.email, phone: guest.phone, birthday: guest.birthday });

  if (!guest.name || !guest.checkIn) {
    return { statusCode: 200, body: 'insufficient data' };
  }

  try {
    // Both Brevo and Notion now require complete guest record (email + phone + birthday)
    if (isCompleteGuest(guest)) {
      await upsertToNotion(notionToken, guest, reservationId);
      if (brevoKey) await upsertToBrevo(brevoKey, guest);
      return { statusCode: 200, body: JSON.stringify({ success: true, synced: true, email: guest.email }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, synced: false, reason: 'incomplete guest record (email + phone + birthday all required)' }) };
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
