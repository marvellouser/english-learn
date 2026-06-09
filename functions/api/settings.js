// functions/api/settings.js
// Cloudflare Pages Function: D1-backed key/value application settings.
//
//   GET  /api/settings  -> { key: value, ... }   (values JSON-decoded)
//   PUT  /api/settings  -> { key, value }         (upsert one)
//                       -> { settings: { ... } }  (upsert many)
//
// The D1 binding is `env.DB`. `value` is stored JSON-encoded.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of results || []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return json(out);
}

export async function onRequestPut({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Accept three shapes: { key, value } | { settings: {map} } | a bare {map}.
  let entries = [];
  if (body && typeof body === 'object' && 'key' in body) {
    entries = [[body.key, body.value]];
  } else if (body && typeof body === 'object' && body.settings && typeof body.settings === 'object') {
    entries = Object.entries(body.settings);
  } else if (body && typeof body === 'object') {
    entries = Object.entries(body);
  }

  const stmt = env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );

  const batch = [];
  for (const [key, value] of entries) {
    if (typeof key !== 'string') continue;
    batch.push(stmt.bind(key, JSON.stringify(value ?? null)));
  }

  if (batch.length) await env.DB.batch(batch);
  return json({ written: batch.length });
}
