export const config = { runtime: 'edge' };

export default async function handler() {
  try {
    const resp = await fetch('https://stooq.com/q/d/l/?s=%5Espx&i=d', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Stooq ${resp.status}`);
    const csv = await resp.text();
    const lines = csv.trim().split('\n');
    const last = lines[lines.length - 1].split(','); // date,open,high,low,close,volume
    const [date, , , , close] = last;
    const value = Number(close);
    if (!Number.isFinite(value)) throw new Error('Invalid CSV');
    return new Response(JSON.stringify({ value, date, source: 'stooq' }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=60'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || 'fetch failed' }), {
      status: 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*'
      }
    });
  }
}
