const NOTION_DATABASE_ID = '326d1aaf-37d9-8022-b6e0-e21a30b28909';

const PROPERTY_MAP = {
  'FS I Boutique La Quinta': 'FS I Boutique La Quinta',
  'FS I Boutique Riviera': 'FS I Boutique Riviera',
  'FS I Boutique Moema II': 'FS Boutique - Moema II',
  'FS I Boutique Moema': 'FS I Boutique Moema',
  'FS I Boutique Ibirapuera': 'FS I Boutique Ibirapuera',
};

async function saveToNotion(token, guest) {
  const properties = {
    'Guest Name': { title: [{ text: { content: guest.name || 'Unknown' } }] },
    'Property': { select: { name: guest.property || '' } },
  };

  if (guest.email) properties['Email'] = { email: guest.email };
  if (guest.phone) properties['Phone'] = { phone_number: guest.phone };
  if (guest.checkIn) {
    properties['Stay'] = {
      date: { start: guest.checkIn, end: guest.checkOut || null }
    };
  }

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const notionToken = process.env.NOTION_TOKEN;
  if (!notionToken) {
    return { statusCode: 500, body: 'NOTION_TOKEN not set' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Only process reservation.updated events
  if (payload.event !== 'reservation.updated') {
    return { statusCode: 200, body: 'ignored' };
  }

  const r = payload.data;
  if (!r) return { statusCode: 200, body: 'no data' };

  // Extract personal email from custom fields (prefer it over masked Airbnb email)
  const customFields = r.customFields || [];
  const personalEmailField = customFields.find(f =>
    f.fieldId && (f.fieldName === 'Personal Email' || f.fieldId === 'personal_email')
  );
  const personalEmail = personalEmailField?.value || null;
  const guestEmail = personalEmail || r.guest?.email || null;

  const listingName = r.listing?.nickname || r.listing?.title || '';
  const mappedProperty = Object.entries(PROPERTY_MAP).find(([key]) =>
    listingName.toLowerCase().includes(key.toLowerCase().replace('fs i boutique ', ''))
  )?.[1] || listingName;

  const guest = {
    name: ((r.guest?.firstName || '') + ' ' + (r.guest?.lastName || '')).trim(),
    email: guestEmail,
    phone: r.guest?.phone || null,
    checkIn: r.checkIn ? r.checkIn.split('T')[0] : null,
    checkOut: r.checkOut ? r.checkOut.split('T')[0] : null,
    property: mappedProperty,
  };

  // Only save if we have at least a name and check-in date
  if (!guest.name || !guest.checkIn) {
    return { statusCode: 200, body: 'insufficient data' };
  }

  try {
    await saveToNotion(notionToken, guest);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
