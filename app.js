const DEFAULT_CENTER = [40.7128, -74.0060]; // New York City fallback
// Multiple public Overpass instances, tried in order — the whole overpass-api.de
// family (including its lz4/z subdomain mirrors) tends to go down or rate-limit
// together, so a genuinely separate host is kept in the list as a real fallback.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

let map, markersLayer, insuranceData = {}, reviewsData = {};
let lastHospitals = [];
let lastSearchCenter = null; // {lat, lon} of the most recent search — always set, used as a distance-sort fallback
let trueUserLocation = null; // {lat, lon, useMiles} — set only by an actual "use my location" action; drives the visible distance badge

async function loadJsonData(path) {
  try {
    // no-cache: these files are meant to be hand-edited locally (see README) —
    // without this, browsers can serve a stale cached copy after an edit even
    // on a hard page reload, since the dev server sends no cache-control headers.
    const res = await fetch(path, { cache: 'no-cache' });
    return await res.json();
  } catch (e) {
    console.warn(`Could not load ${path}`, e);
    return {};
  }
}

function initMap() {
  map = L.map('map').setView(DEFAULT_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function setStatus(msg) {
  document.getElementById('status-line').textContent = msg;
}

// Nominatim's free-text search ranks purely by global "importance" and — unlike
// a typeahead — doesn't return lower-ranked homonyms as alternates at all: search
// "Berlin" and only Berlin, Germany comes back, even with a high `limit`, even
// with `dedupe=0`. There's no candidate list to re-rank client-side. The only
// reliable fix is to qualify the query itself: if the user didn't already type a
// qualifier (no comma), append the country of wherever they're currently looking
// on the map, so "Berlin" while viewing Illinois resolves in the US, not Germany.
let cachedCountryContext = null; // { lat, lon, country } — avoids a reverse-geocode per search

async function getCountryContext(lat, lon) {
  if (cachedCountryContext &&
      Math.abs(cachedCountryContext.lat - lat) < 0.5 &&
      Math.abs(cachedCountryContext.lon - lon) < 0.5) {
    return cachedCountryContext.country;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=3`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const country = data?.address?.country || null;
    cachedCountryContext = { lat, lon, country };
    return country;
  } catch (e) {
    console.warn('Could not determine map country context for search bias.', e);
    return null;
  }
}

async function fetchGeocodeResults(q) {
  const params = new URLSearchParams({ format: 'json', limit: '1', q });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Geocoding error: ${res.status}`);
  return res.json();
}

// Appending a country qualifier can itself misfire: forcing "Seoul, United
// States" (when the map just hasn't moved there yet) matches a restaurant named
// Seoul in Texas instead of failing cleanly — Nominatim will find *something*
// almost anywhere. Real places (cities, towns, admin areas) score far higher on
// "importance" than incidental points of interest, so this filters those out.
function looksLikeRealPlace(result) {
  const classOk = result.class === 'boundary' || result.class === 'place';
  const importance = typeof result.importance === 'number' ? result.importance : 1;
  return classOk && importance > 0.05;
}

async function geocode(query) {
  const trimmed = query.trim();
  let effectiveQuery = trimmed;
  let qualified = false;

  if (!trimmed.includes(',') && map) {
    const center = map.getCenter();
    const country = await getCountryContext(center.lat, center.lng);
    if (country && !trimmed.toLowerCase().includes(country.toLowerCase())) {
      effectiveQuery = `${trimmed}, ${country}`;
      qualified = true;
    }
  }

  let data = await fetchGeocodeResults(effectiveQuery);
  if (qualified && (!data.length || !looksLikeRealPlace(data[0]))) {
    // Either nothing matched with the qualifier, or it matched some low-quality
    // stray point rather than an actual place — the user's original query,
    // taken at face value, is almost certainly what they meant.
    const fallback = await fetchGeocodeResults(trimmed);
    if (fallback.length) data = fallback;
  }
  if (!data.length) throw new Error('Location not found. Try a different search.');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
}

function currentRadiusMeters() {
  return parseInt(document.getElementById('radius-select').value, 10);
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km, useMiles) {
  if (useMiles) {
    const mi = km * 0.621371;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

// Reverse-geocodes just to find the country, so distances can show in the units
// people there actually use (miles in the US, km everywhere else).
async function isInUnitedStates(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=3`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.address?.country_code === 'us';
  } catch (e) {
    console.warn('Could not determine country for distance units; defaulting to km.', e);
    return false;
  }
}

async function fetchHospitals(lat, lon, radius) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      way["amenity"="hospital"](around:${radius},${lat},${lon});
      relation["amenity"="hospital"](around:${radius},${lat},${lon});
    );
    out center tags;
  `;

  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, { method: 'POST', body: query, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);
      const data = await res.json();
      return data.elements.map(normalizeHospital).filter(Boolean);
    } catch (e) {
      console.warn(`Overpass endpoint failed (${url}):`, e.message);
      lastError = e;
    }
  }
  throw lastError || new Error('All Overpass endpoints failed.');
}

function normalizeHospital(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const addressParts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode']
  ].filter(Boolean);

  return {
    id: `${el.type}/${el.id}`,
    name: tags.name || 'Unnamed hospital',
    lat, lon,
    address: addressParts.join(', ') || null,
    phone: tags.phone || tags['contact:phone'] || null,
    website: tags.website || tags['contact:website'] || null,
    emergency: tags.emergency === 'yes',
    openingHoursRaw: tags.opening_hours || null
  };
}

// --- Simplified OSM opening_hours evaluator ---
// Handles common real-world patterns: "24/7", day ranges/lists (Mo-Fr, Sa,Su),
// multiple time ranges, semicolon-separated rule groups, and "off" overrides.
// OSM's full opening_hours spec is much richer (holidays, seasons, etc.) — anything
// outside this subset falls back to "unknown" rather than guessing.
const DAY_CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function expandDayRange(token) {
  const rangeMatch = token.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)-(Mo|Tu|We|Th|Fr|Sa|Su)$/);
  if (rangeMatch) {
    const start = DAY_CODES.indexOf(rangeMatch[1]);
    const end = DAY_CODES.indexOf(rangeMatch[2]);
    const days = [];
    let i = start;
    while (true) {
      days.push(i);
      if (i === end) break;
      i = (i + 1) % 7;
    }
    return days;
  }
  const single = DAY_CODES.indexOf(token);
  return single === -1 ? [] : [single];
}

function evaluateOpeningHours(raw, now = new Date()) {
  if (!raw) return 'unknown';
  const cleaned = raw.trim();
  if (cleaned === '24/7') return 'open';

  const rules = cleaned.split(';').map(r => r.trim()).filter(Boolean);
  const currentDay = now.getDay(); // 0 = Sunday
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  let matched = null; // later rules override earlier ones, per OSM semantics

  for (const rule of rules) {
    if (/^(PH|SH)\b/.test(rule)) continue; // public/school holiday rules not supported

    const isOff = /\boff\b/.test(rule);
    const dayTokenMatch = rule.match(
      /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)/
    );
    const days = dayTokenMatch
      ? dayTokenMatch[1].split(',').flatMap(t => expandDayRange(t.trim()))
      : [0, 1, 2, 3, 4, 5, 6]; // no day spec = every day

    if (!days.includes(currentDay)) continue;

    if (isOff) {
      matched = false;
      continue;
    }

    const timeRanges = [...rule.matchAll(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/g)];
    if (!timeRanges.length) continue; // day matched but no parseable time range

    let withinAnyRange = false;
    for (const [, h1, m1, h2, m2] of timeRanges) {
      const start = parseInt(h1, 10) * 60 + parseInt(m1, 10);
      let end = parseInt(h2, 10) * 60 + parseInt(m2, 10);
      if (end <= start) end += 24 * 60; // overnight range
      if (currentMinutes >= start && currentMinutes < end) {
        withinAnyRange = true;
        break;
      }
    }
    matched = withinAnyRange;
  }

  if (matched === null) return 'unknown';
  return matched ? 'open' : 'closed';
}

function lookupInsurance(name) {
  const key = name.trim().toLowerCase();
  return insuranceData[key] || null;
}

function lookupReviews(name) {
  const key = name.trim().toLowerCase();
  return reviewsData[key] || null;
}

const INSURANCE_FILTER_KEY = 'hospitalsMap.insuranceFilter';

// Some "insurances" entries are actually descriptive notes rather than plan
// names (e.g. a long "International Healthcare Center: ..." string) — a length
// cutoff keeps those out of the dropdown without hardcoding specific strings.
function collectInsuranceOptions() {
  const set = new Set();
  Object.entries(insuranceData).forEach(([key, val]) => {
    if (key === '_readme') return;
    (val.insurances || []).forEach(name => {
      if (name.length <= 60) set.add(name);
    });
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function populateInsuranceOptions() {
  const select = document.getElementById('insurance-select');
  if (!select) return;
  const options = collectInsuranceOptions();
  let saved = null;
  try { saved = localStorage.getItem(INSURANCE_FILTER_KEY); } catch (e) { /* ignore */ }

  select.innerHTML = '<option value="">Any / show all</option>' +
    options.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (saved && options.includes(saved)) select.value = saved;

  select.addEventListener('change', () => {
    try { localStorage.setItem(INSURANCE_FILTER_KEY, select.value); } catch (e) { /* ignore */ }
    refreshHospitalDisplay();
  });
}

function getSelectedInsurance() {
  const select = document.getElementById('insurance-select');
  return select && select.value ? select.value : null;
}

const SPECIALTY_FILTER_KEY = 'hospitalsMap.specialtyFilter';
const DEFAULT_SPECIALTY = 'General / Acute Care';

function collectSpecialtyOptions() {
  const set = new Set();
  Object.entries(insuranceData).forEach(([key, val]) => {
    if (key === '_readme') return;
    if (val.specialty) set.add(val.specialty);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function populateSpecialtyOptions() {
  const select = document.getElementById('specialty-select');
  if (!select) return;
  const options = collectSpecialtyOptions();
  let saved = null;
  try { saved = localStorage.getItem(SPECIALTY_FILTER_KEY); } catch (e) { /* ignore */ }

  select.innerHTML = '<option value="">Any / show all</option>' +
    options.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (saved && options.includes(saved)) select.value = saved;

  select.addEventListener('change', () => {
    try { localStorage.setItem(SPECIALTY_FILTER_KEY, select.value); } catch (e) { /* ignore */ }
    refreshHospitalDisplay();
  });
}

function getSelectedSpecialty() {
  const select = document.getElementById('specialty-select');
  return select && select.value ? select.value : null;
}

// Google's own 5-star-down-to-1-star review counts, shown as a tiny bar chart.
// Only rendered when sourced directly from real review data (see reviews-data.json's _readme).
function renderRatingBreakdown(breakdown) {
  if (!Array.isArray(breakdown) || breakdown.length !== 5) return '';
  const labels = ['5★', '4★', '3★', '2★', '1★'];
  const max = Math.max(...breakdown, 1);
  const rows = breakdown.map((count, i) => {
    const pct = Math.round((count / max) * 100);
    return (
      `<div class="rating-bar-row">` +
      `<span class="rating-bar-label">${labels[i]}</span>` +
      `<span class="rating-bar-track"><span class="rating-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="rating-bar-count">${count.toLocaleString()}</span>` +
      `</div>`
    );
  }).join('');
  return `<div class="rating-breakdown">${rows}</div>`;
}

// Google's own extracted review topics (e.g. "Nurses · 47"), curated in the data
// file to drop mistranslated/nonsensical chips. Only shown when present.
function renderTopics(topics) {
  if (!Array.isArray(topics) || !topics.length) return '';
  const chips = topics
    .map(([label, count]) => `<span class="topic-chip">${escapeHtml(label)} · ${count}</span>`)
    .join('');
  return `<div class="topics-row">${chips}</div>`;
}

function renderReviewSummary(review) {
  if (!review) {
    return '<div class="reviews-empty">Coming soon</div>';
  }
  const lines = [];
  if (review.rating != null) {
    const count = review.reviewCount != null ? ` (${review.reviewCount.toLocaleString()} ratings)` : '';
    lines.push(`<div class="reviews-rating">⭐ ${Number(review.rating).toFixed(1)}${count}</div>`);
  }
  lines.push(renderRatingBreakdown(review.ratingBreakdown));
  lines.push(renderTopics(review.topics));
  if (review.summary) {
    lines.push(`<div class="review-snippet">${escapeHtml(review.summary)}</div>`);
  }
  if (review.asOf) {
    lines.push(`<div class="popup-note">Based on reviews as of ${escapeHtml(review.asOf)} — may be out of date.</div>`);
  }
  return lines.join('') || '<div class="reviews-empty">Coming soon</div>';
}

function statusBadge(status) {
  if (status === 'open') return '<span class="badge open">Open now</span>';
  if (status === 'closed') return '<span class="badge closed">Closed</span>';
  return '<span class="badge unknown">Hours unknown</span>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function buildPopupHtml(h, status, insurance, review, distanceKm, matchesInsurance, matchesSpecialty) {
  const lines = [`<strong>${escapeHtml(h.name)}</strong>`];
  lines.push(statusBadge(status));
  const specialty = insurance && insurance.specialty;
  if (specialty && specialty !== DEFAULT_SPECIALTY) {
    lines.push(`<span class="badge specialty${matchesSpecialty ? ' specialty-match' : ''}">${escapeHtml(specialty)}</span>`);
  }
  if (matchesInsurance) lines.push('<div><span class="badge match">✓ Accepts your insurance</span></div>');
  if (h.emergency) lines.push('<div>🚑 Emergency department</div>');
  if (h.openingHoursRaw) lines.push(`<div class="popup-hours">Hours: ${escapeHtml(h.openingHoursRaw)}</div>`);
  if (h.address) lines.push(`<div>${escapeHtml(h.address)}</div>`);
  if (trueUserLocation && distanceKm != null) {
    lines.push(`<div>📍 ${formatDistance(distanceKm, trueUserLocation.useMiles)} away</div>`);
  }
  if (h.phone) lines.push(`<div>📞 ${escapeHtml(h.phone)}</div>`);
  if (h.website) lines.push(`<div><a href="${escapeHtml(h.website)}" target="_blank" rel="noopener">Website</a></div>`);
  if (insurance && insurance.erWaitUrl) {
    lines.push(`<div>⏱️ <a href="${escapeHtml(insurance.erWaitUrl)}" target="_blank" rel="noopener">Check current ER wait time</a></div>`);
  }
  lines.push(
    '<div class="popup-insurance"><strong>Insurance accepted:</strong><br>' +
    (insurance ? escapeHtml(insurance.insurances.join(', ')) : 'Not listed — verify with the hospital') +
    '</div>'
  );
  if (insurance && insurance.note) {
    lines.push(`<div class="popup-note">${escapeHtml(insurance.note)}</div>`);
  }
  lines.push('<div class="popup-reviews"><strong>Reviews:</strong>');
  lines.push(`<div class="reviews-container">${renderReviewSummary(review)}</div>`);
  lines.push('</div>');
  return `<div class="popup">${lines.join('')}</div>`;
}

function renderHospitals(hospitals) {
  lastHospitals = hospitals;
  refreshHospitalDisplay();
}

// Re-renders the currently-cached hospital list against the current insurance
// filter and distance reference, without re-fetching from Overpass. Called both
// after a fresh search and whenever the insurance dropdown changes.
function refreshHospitalDisplay() {
  markersLayer.clearLayers();
  const listEl = document.getElementById('hospital-list');
  listEl.innerHTML = '';

  if (!lastHospitals.length) {
    setStatus('No hospitals found in this area. Try a larger radius.');
    return;
  }

  const selectedInsurance = getSelectedInsurance();
  const selectedSpecialty = getSelectedSpecialty();
  const distanceRef = trueUserLocation || lastSearchCenter;
  const activeFilterCount = (selectedInsurance ? 1 : 0) + (selectedSpecialty ? 1 : 0);

  const decorated = lastHospitals.map(h => {
    const status = evaluateOpeningHours(h.openingHoursRaw);
    const insurance = lookupInsurance(h.name);
    const review = lookupReviews(h.name);
    const distanceKm = distanceRef
      ? haversineDistanceKm(distanceRef.lat, distanceRef.lon, h.lat, h.lon)
      : null;
    const matchesInsurance = !!(selectedInsurance && insurance && insurance.insurances.includes(selectedInsurance));
    const matchesSpecialty = !!(selectedSpecialty && insurance && insurance.specialty === selectedSpecialty);
    const matchScore = (selectedInsurance && matchesInsurance ? 1 : 0) + (selectedSpecialty && matchesSpecialty ? 1 : 0);
    return { h, status, insurance, review, distanceKm, matchesInsurance, matchesSpecialty, matchScore };
  });

  // Best match first: hospitals satisfying the active filters (insurance and/or
  // type of care), nearest first within each group — a real "recommendation"
  // once filters are set.
  decorated.sort((a, b) => {
    if (activeFilterCount && a.matchScore !== b.matchScore) {
      return b.matchScore - a.matchScore;
    }
    if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
    return 0;
  });

  const statusParts = [`Found ${decorated.length} hospital${decorated.length === 1 ? '' : 's'}`];
  if (selectedInsurance) {
    const matchCount = decorated.filter(d => d.matchesInsurance).length;
    statusParts.push(matchCount > 0
      ? `${matchCount} listed as accepting ${selectedInsurance}`
      : `none listed as accepting ${selectedInsurance} here`);
  }
  if (selectedSpecialty) {
    const matchCount = decorated.filter(d => d.matchesSpecialty).length;
    statusParts.push(matchCount > 0
      ? `${matchCount} tagged ${selectedSpecialty}`
      : `none tagged ${selectedSpecialty} here`);
  }
  setStatus(statusParts.length > 1
    ? `${statusParts[0]} — ${statusParts.slice(1).join('; ')}.`
    : `${statusParts[0]}.`);

  decorated.forEach(({ h, status, insurance, review, distanceKm, matchesInsurance, matchesSpecialty, matchScore }, idx) => {
    const marker = L.marker([h.lat, h.lon]);
    marker.bindPopup(buildPopupHtml(h, status, insurance, review, distanceKm, matchesInsurance, matchesSpecialty));
    marker.addTo(markersLayer);

    const isBestMatch = activeFilterCount > 0 && matchScore === activeFilterCount && idx === 0;
    const specialty = insurance && insurance.specialty;
    const showSpecialtyChip = specialty && specialty !== DEFAULT_SPECIALTY;
    const li = document.createElement('li');
    li.className = 'hospital-item' +
      (matchesInsurance ? ' insurance-match' : '') +
      (matchesSpecialty ? ' specialty-match-item' : '');
    li.innerHTML = `
      <div class="hospital-name">${escapeHtml(h.name)}</div>
      ${statusBadge(status)}
      ${showSpecialtyChip ? `<span class="badge specialty${matchesSpecialty ? ' specialty-match' : ''}">${escapeHtml(specialty)}</span>` : ''}
      ${isBestMatch ? '<span class="badge match">⭐ Best match</span>' : ''}
      ${!isBestMatch && matchesInsurance ? '<span class="badge match">✓ Accepts your insurance</span>' : ''}
      <div class="hospital-address">${escapeHtml(h.address || 'Address unavailable')}</div>
      ${trueUserLocation && distanceKm != null ? `<div class="hospital-distance">${formatDistance(distanceKm, trueUserLocation.useMiles)} away</div>` : ''}
    `;
    li.addEventListener('click', () => {
      map.setView([h.lat, h.lon], 17);
      marker.openPopup();
    });
    listEl.appendChild(li);
  });
}

async function searchHospitalsAt(lat, lon) {
  setStatus('Searching for hospitals...');
  lastSearchCenter = { lat, lon };
  try {
    const radius = currentRadiusMeters();
    const hospitals = await fetchHospitals(lat, lon, radius);
    renderHospitals(hospitals);
  } catch (e) {
    console.error(e);
    setStatus('Error fetching hospital data. Please try again in a moment.');
  }
}

function centerMapAt(lat, lon, label) {
  map.setView([lat, lon], 13);
  L.circleMarker([lat, lon], { radius: 6, color: '#2563eb' })
    .addTo(map)
    .bindPopup(label || 'Search location')
    .openPopup();
}

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new Error(`Could not get location: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

const AUTO_LOCATE_KEY = 'hospitalsMap.autoLocate';

function isAutoLocateEnabled() {
  try {
    return localStorage.getItem(AUTO_LOCATE_KEY) !== 'off'; // on by default
  } catch (e) {
    return true;
  }
}

function setAutoLocateEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_LOCATE_KEY, enabled ? 'on' : 'off');
  } catch (e) {
    // localStorage unavailable (private browsing, etc.) — setting just won't persist
  }
}

async function tryAutoLocate() {
  if (!isAutoLocateEnabled()) {
    setStatus('Search a location or use your current location to find nearby hospitals.');
    return;
  }
  setStatus('Finding your location...');
  try {
    const { lat, lon } = await locateUser();
    const useMiles = await isInUnitedStates(lat, lon);
    trueUserLocation = { lat, lon, useMiles };
    map.setView([lat, lon], 14);
    await searchHospitalsAt(lat, lon);
  } catch (e) {
    console.warn(e);
    setStatus('Search a location or use your current location to find nearby hospitals.');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  insuranceData = await loadJsonData('insurance-data.json');
  reviewsData = await loadJsonData('reviews-data.json');
  populateInsuranceOptions();
  populateSpecialtyOptions();

  const autoLocateToggle = document.getElementById('auto-locate-toggle');
  if (autoLocateToggle) {
    autoLocateToggle.checked = isAutoLocateEnabled();
    autoLocateToggle.addEventListener('change', () => {
      setAutoLocateEnabled(autoLocateToggle.checked);
    });
  }

  document.getElementById('locate-btn').addEventListener('click', () => {
    setStatus('Getting your location...');
    locateUser()
      .then(async ({ lat, lon }) => {
        const useMiles = await isInUnitedStates(lat, lon);
        trueUserLocation = { lat, lon, useMiles };
        map.setView([lat, lon], 14);
        await searchHospitalsAt(lat, lon);
      })
      .catch(err => setStatus(err.message));
  });

  tryAutoLocate();

  document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;
    setStatus('Searching location...');
    trueUserLocation = null; // a typed search is no longer "my location"
    try {
      const { lat, lon, label } = await geocode(query);
      centerMapAt(lat, lon, label);
      await searchHospitalsAt(lat, lon);
    } catch (err) {
      setStatus(err.message);
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', () => {
    const center = map.getCenter();
    searchHospitalsAt(center.lat, center.lng);
  });
});
