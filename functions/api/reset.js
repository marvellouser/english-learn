// functions/api/reset.js
// Cloudflare Pages Function: wipe all review progress in one round-trip.
//
//   POST /api/reset  -> DELETE every review_state row, returning the count.
//
// Deleting the rows is equivalent to resetting every word to "new" (the frontend
// synthesizes a brand-new state for any word without a row). The streak setting
// is reset separately by the caller via PUT /api/settings.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

export async function onRequestPost({ env }) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM review_state').first();
  await env.DB.prepare('DELETE FROM review_state').run();
  return json({ reset: row ? row.n : 0 });
}
