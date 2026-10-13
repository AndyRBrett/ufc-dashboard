// Apple Push Notification service (APNs) for the native iOS build.
//
// Web Push doesn't run inside an iOS app's web view, so the App Store build
// registers an APNs device token (apns_devices, 0022) and send-push delivers
// to it here, beside its web-push loop. Plain JS on WebCrypto and fetch only,
// so it runs unchanged in Deno and in the Node tests (check:pushauth).
//
// Auth is a provider token: an ES256 JWT signed with the .p8 key from the
// Apple Developer account (Keys -> Apple Push Notifications service). Apple
// wants it refreshed between 20 and 60 minutes old and answers
// TooManyProviderTokenUpdates if it changes more often, so one token is kept
// per instance and reused for APNS_TOKEN_TTL_MS.
//
// Secrets (Supabase function secrets). With any of them unset, apnsConfig()
// is null and send-push never reads apns_devices: deploying this before the
// Apple account exists changes nothing.
//   APNS_KEY      the .p8 file's contents (PEM; literal "\n" escapes are fine)
//   APNS_KEY_ID   the key's 10-character id
//   APNS_TEAM_ID  the developer team id
//   APNS_TOPIC    the app's bundle id (native/capacitor.config.json appId)

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
// Apple's limit for an alert push is 4096 bytes of JSON.
export const APNS_MAX_PAYLOAD = 4096;
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
export const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/;

export function apnsConfig(env) {
  const key = env("APNS_KEY") || "", keyId = env("APNS_KEY_ID") || "", teamId = env("APNS_TEAM_ID") || "", topic = env("APNS_TOPIC") || "";
  return key && keyId && teamId && topic ? { key, keyId, teamId, topic } : null;
}

const enc = new TextEncoder();
function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function pemToPkcs8(pem) {
  const b64 = String(pem).replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// WebCrypto's ECDSA signature is already the raw r||s (IEEE P1363) form JWS
// ES256 wants, so it goes into the token as-is.
export async function apnsJwt(cfg, nowMs) {
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: cfg.keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(nowMs / 1000) })));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(cfg.key), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims)));
  return header + "." + claims + "." + b64url(sig);
}

let _tok = null;   // { jwt, at, kid }
export async function providerToken(cfg, nowMs) {
  if (_tok && _tok.kid === cfg.keyId && nowMs - _tok.at < APNS_TOKEN_TTL_MS) return _tok.jwt;
  const jwt = await apnsJwt(cfg, nowMs);
  _tok = { jwt, at: nowMs, kid: cfg.keyId };
  return jwt;
}
export function resetProviderToken() { _tok = null; }

// The notification, plus the same routing fields the service worker's tap
// reads (url, kind) and the full text for the in-app sheet. A body too long
// for Apple's limit is shortened (the roast inbox still holds the whole one).
export function apnsPayload(msg) {
  const build = (body) => JSON.stringify({
    aps: { alert: { title: msg.title || "Picked Fight", body }, sound: "default" },
    ...(msg.url ? { url: msg.url } : {}),
    ...(msg.kind ? { kind: msg.kind } : {}),
    title: msg.title || "",
    fullMessage: body,
  });
  let body = String(msg.body || "");
  let out = build(body);
  while (enc.encode(out).length > APNS_MAX_PAYLOAD && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - Math.max(16, Math.ceil(body.length / 10)))) + "…";
    if (body === "…") body = "";
    out = build(body);
  }
  return out;
}

// One push. Never throws: a transport error is { ok: false, status: 0 }.
// gone is true when Apple says the token is dead and the row should go.
export async function sendApns(cfg, device, payload, nowMs) {
  const host = HOSTS[device.env] || HOSTS.production;
  try {
    const r = await fetch(`${host}/3/device/${device.token}`, {
      method: "POST",
      headers: {
        "authorization": "bearer " + await providerToken(cfg, nowMs),
        "apns-topic": cfg.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: payload,
    });
    if (r.ok) return { ok: true, status: r.status, gone: false };
    let reason = "";
    try { reason = (await r.json()).reason || ""; } catch (_e) { /* no body */ }
    // An expired provider token: mint a fresh one on the next send.
    if (r.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(reason)) resetProviderToken();
    const gone = r.status === 410 || (r.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(reason));
    return { ok: false, status: r.status, reason, gone };
  } catch (e) {
    return { ok: false, status: 0, reason: String(e).slice(0, 200), gone: false };
  }
}
