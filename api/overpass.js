// Vercel serverless proxy for hospital lookups. Public Overpass servers reject
// browser requests coming from *.vercel.app pages (HTTP 406/403), so the page
// asks this function and the server fetches the data instead. Only a fixed
// hospital query is ever sent upstream, so it can't be used as an open proxy.
const UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter'
];
const USER_AGENT = 'hospital-finder/1.0 (https://github.com/minsoo070420-pixel/hospital-finder)';

module.exports = async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Number(req.query.radius);
  const valid =
    Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lon) && Math.abs(lon) <= 180 &&
    Number.isFinite(radius) && radius >= 100 && radius <= 30000;
  if (!valid) {
    res.status(400).json({ error: 'lat, lon and radius (100-30000 m) are required' });
    return;
  }

  const query = `[out:json][timeout:25];(
    node["amenity"="hospital"](around:${Math.round(radius)},${lat},${lon});
    way["amenity"="hospital"](around:${Math.round(radius)},${lat},${lon});
    relation["amenity"="hospital"](around:${Math.round(radius)},${lat},${lon});
  );out center tags;`;

  const controllers = [];
  const failures = [];
  const attempt = async (url) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      return await upstream.json();
    } catch (e) {
      failures.push(`${new URL(url).hostname}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const data = await Promise.any(UPSTREAMS.map(attempt));
    controllers.forEach((c) => c.abort());
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'All upstream servers failed', details: [...new Set(failures)] });
  }
};
