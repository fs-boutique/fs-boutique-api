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

// Upsert contact to Brevo — only if we have a personal email
async function upsertToBrevo(apiKey, guest) {
  if (!guest.email || guest.email.includes('guest.booking.com') || guest.email.includes('airbnb')) {
    return; // skip masked/platform emails
  }

  const nameParts = guest.name.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      email: guest.email,
      updateEnabled: true,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME: lastName,
        SMS: guest.phone || '',
        PROPERTY: guest.property || '',
        LAST_CHECKIN: guest.checkIn || '',
        LAST_CHECKOUT: guest.checkOut || ''
      },
      listIds: [2] // default list — FS Boutique Guest List
    })
  });

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

  // Extract personal email from custom fields
  const customFields = r.customFields || [];
  let personalEmail = null;
  for (const f of customFields) {
    const val = f.value || f.fieldValue || '';
    const name = (f.fieldName || f.name || '').toLowerCase();
    if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      if (!personalEmail || name.includes('email') || name.includes('personal')) {
        personalEmail = val;
      }
    }
  }
  const guestEmail = personalEmail || r.guest?.email || null;

  const listingName = r.listing?.nickname || r.listing?.title || '';
  const mappedProperty = Object.entries(PROPERTY_MAP).find(([key]) =>
    listingName.toLowerCase().includes(key.toLowerCase().replace('fs i boutique ', ''))
  )?.[1] || listingName;

  const guest = {
    name: r.guest?.fullName || ((r.guest?.firstName || '') + ' ' + (r.guest?.lastName || '')).trim(),
    email: guestEmail,
    phone: r.guest?.phone || null,
    checkIn: r.checkIn ? r.checkIn.split('T')[0] : null,
    checkOut: r.checkOut ? r.checkOut.split('T')[0] : null,
    property: mappedProperty,
  };

  if (!guest.name || !guest.checkIn) {
    return { statusCode: 200, body: 'insufficient data' };
  }

  try {
    // Notion gate: only write if we have BOTH email and phone (no holes)
    if (guest.email && guest.phone) {
      await upsertToNotion(notionToken, guest, reservationId);
    }
    if (brevoKey) await upsertToBrevo(brevoKey, guest);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
