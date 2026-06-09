// functions/api/review-states.js
// Cloudflare Pages Function: D1-backed per-word SM-2 review states.
//
//   GET  /api/review-states  -> all review-state rows as a JSON array
//   PUT  /api/review-states  -> upsert one state (object) OR many (array)
//
// The D1 binding is `env.DB` (see wrangler.toml / Pages dashboard binding).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Progress must always be fresh; never let a cache (browser or SW) serve it.
      'cache-control': 'no-store',
    },
  });

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const int = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT id, ease, "interval", reps, due, lastReviewed, introducedOn, lapses FROM review_state'
  ).all();
  return json(results || []);
}

export async function onRequestPut({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const states = Array.isArray(body) ? body : [body];

  const stmt = env.DB.prepare(
    `INSERT INTO review_state (id, ease, "interval", reps, due, lastReviewed, introducedOn, lapses)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       ease         = excluded.ease,
       "interval"   = excluded."interval",
       reps         = excluded.reps,
       due          = excluded.due,
       lastReviewed = excluded.lastReviewed,
       introducedOn = excluded.introducedOn,
       lapses       = excluded.lapses`
  );

  const batch = [];
  for (const s of states) {
    if (!s || typeof s.id !== 'string') continue;
    batch.push(
      stmt.bind(
        s.id,
        num(s.ease, 2.5),
        int(s.interval, 0),
        int(s.reps, 0),
        s.due ?? null,
        s.lastReviewed ?? null,
        s.introducedOn ?? null,
        int(s.lapses, 0)
      )
    );
  }

  if (batch.length) await env.DB.batch(batch);
  return json({ written: batch.length });
}
