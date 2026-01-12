// edmonson-beacon-scraper.js

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const BASE_URL = 'https://beacon.schneidercorp.com/?site=EdmonsonCountyKY';

// TODO: fill these from DevTools
const SEARCH_URL = 'https://beacon.schneidercorp.com/XXXX/Search';      // parcel search
const DETAILS_URL = 'https://beacon.schneidercorp.com/XXXX/Details';    // parcel details
const GEOM_URL = 'https://beacon.schneidercorp.com/XXXX/Geometry';      // parcel geometry

async function createSession() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  // Initial GET to set cookies and grab any tokens if needed
  const resp = await client.get(BASE_URL);
  const html = resp.data;

  // If there is an anti-forgery token in a hidden input, extract it here
  // Example (adjust regex based on actual markup):
  const tokenMatch = html.match(/name="__RequestVerificationToken" value="([^"]+)"/);
  const csrfToken = tokenMatch ? tokenMatch[1] : null;

  return { client, csrfToken };
}

function buildWildcardTerms() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const digits = '0123456789'.split('');
  return [...letters, ...digits].map(ch => ch + '*');
}

async function searchParcels(client, csrfToken, term) {
  // Inspect DevTools to match the real method and payload
  const payload = {
    // Example shape – replace with the real one
    searchText: term,
    searchType: 'Owner', // or 'ParcelID', 'Address' etc.
  };

  const headers = {};
  if (csrfToken) {
    headers['RequestVerificationToken'] = csrfToken; // or correct header name
  }

  const { data } = await client.post(SEARCH_URL, payload, { headers });

  // Adjust this mapping based on actual response structure
  return (data.results || data || []).map(item => ({
    parcelId: item.parcelId || item.ParcelID || item.PIN || null,
    owner: item.owner || item.OwnerName || null,
    summary: item,
  }));
}

async function fetchParcelDetails(client, csrfToken, parcelId) {
  const headers = {};
  if (csrfToken) {
    headers['RequestVerificationToken'] = csrfToken;
  }

  // Might be POST or GET; adjust based on DevTools
  const { data } = await client.post(
    DETAILS_URL,
    { parcelId },          // or whatever key is used (e.g., { id: parcelId })
    { headers }
  );

  return data;
}

async function fetchParcelGeometry(client, csrfToken, parcelId) {
  const headers = {};
  if (csrfToken) {
    headers['RequestVerificationToken'] = csrfToken;
  }

  const { data } = await client.post(
    GEOM_URL,
    { parcelId },          // adjust to real payload
    { headers }
  );

  // Expect geometry as coordinates or ESRI JSON; just return raw for now
  return data;
}

async function scrapeAllParcels() {
  const { client, csrfToken } = await createSession();
  const terms = buildWildcardTerms();

  const parcelMap = new Map(); // parcelId -> { attributes, geometry }

  for (const term of terms) {
    console.log(`Searching with term: ${term}`);
    const partials = await searchParcels(client, csrfToken, term);

    for (const p of partials) {
      if (!p.parcelId || parcelMap.has(p.parcelId)) continue;

      try {
        const [details, geometry] = await Promise.all([
          fetchParcelDetails(client, csrfToken, p.parcelId),
          fetchParcelGeometry(client, csrfToken, p.parcelId),
        ]);

        parcelMap.set(p.parcelId, {
          parcelId: p.parcelId,
          owner: p.owner,
          // Adjust according to the structure you see
          mailingAddress: details.mailingAddress || null,
          propertyAddress: details.propertyAddress || null,
          acreage: details.acres || details.acreage || null,
          assessedValue: details.assessedValue || null,
          landUse: details.landUse || null,
          attributes: details,
          geometry, // raw geometry payload
        });
      } catch (err) {
        console.warn(`Failed parcel ${p.parcelId}:`, err.message);
      }
    }
  }

  return Array.from(parcelMap.values());
}

(async () => {
  try {
    const parcels = await scrapeAllParcels();
    console.log(`Total unique parcels: ${parcels.length}`);
    console.log(JSON.stringify(parcels, null, 2));
  } catch (err) {
    console.error('Scrape failed:', err);
  }
})();