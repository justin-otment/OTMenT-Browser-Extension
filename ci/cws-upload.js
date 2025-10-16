const fs = require('fs');
const axios = require('axios');
const path = require('path');

const clientId = process.env.CWS_CLIENT_ID;
const clientSecret = process.env.CWS_CLIENT_SECRET;
const refreshToken = process.env.CWS_REFRESH_TOKEN;
const zipPath = path.resolve(__dirname, '../extension.zip');

if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing CWS credentials');
  process.exit(2);
}

async function getAccessToken() {
  const res = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }
  });
  return res.data.access_token;
}

async function upload(accessToken) {
  const zip = fs.readFileSync(zipPath);
  const uploadUrl = `https://www.googleapis.com/upload/chromewebstore/v1.1/items`;
  const res = await axios.post(uploadUrl, zip, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': '2',
      'content-type': 'application/zip'
    }
  });
  return res.data;
}

async function publish(accessToken, itemId) {
  const publishUrl = `https://www.googleapis.com/chromewebstore/v1.1/items/${itemId}/publish`;
  const res = await axios.post(publishUrl, null, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': '2'
    },
    params: { publishTarget: 'default' }
  });
  return res.data;
}

(async () => {
  try {
    const token = await getAccessToken();
    const uploadRes = await upload(token);
    console.log('UPLOAD_RES', uploadRes);
    const itemId = uploadRes.id;
    const pubRes = await publish(token, itemId);
    console.log('PUBLISH_RES', pubRes);
    if (pubRes && pubRes.status && pubRes.status.includes('OK')) {
      console.log('PUBLISHED');
      process.exit(0);
    } else {
      console.error('PUBLISH_FAILED', pubRes);
      process.exit(3);
    }
  } catch (err) {
    console.error('ERROR', err.response ? err.response.data : err);
    process.exit(4);
  }
})();