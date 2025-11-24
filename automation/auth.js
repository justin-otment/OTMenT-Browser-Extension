import crypto from "crypto";
import fetch from "node-fetch";

export async function getServiceAccountToken(config, serviceAccount, rsaPrivateKey) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600
  };

  const b64url = obj =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    rsaPrivateKey
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const assertion = `${unsigned}.${signature}`;

  const res = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}
