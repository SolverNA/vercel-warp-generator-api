'use strict';

const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────
const CF_API      = 'https://api.cloudflareclient.com/v0i1909051800';
const API_SECRET  = process.env.API_SECRET;   // set in Vercel → Settings → Env Vars
const MAX_RETRIES = 3;
const RETRY_MS    = 1200;
const TIMEOUT_MS  = 12000;

// ─── WireGuard key generation (X25519 via Node built-in crypto) ───────────────
function generateWireGuardKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  // PKCS8 DER (48 bytes): raw private key = last 32 bytes
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // SPKI DER (44 bytes): raw public key = last 32 bytes
  const pubDer  = publicKey.export({ type: 'spki',  format: 'der' });
  return {
    privateKey : privDer.slice(-32).toString('base64'),
    publicKey  : pubDer .slice(-32).toString('base64'),
  };
}

// ─── Retry-aware Cloudflare fetch ─────────────────────────────────────────────
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function cfRequest(method, path, token = null, body = null, attempt = 1) {
  const headers = {
    'User-Agent'   : 'okhttp/3.12.1',
    'Content-Type' : 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res, data;
  try {
    res  = await fetch(`${CF_API}/${path}`, {
      method,
      headers,
      body   : body ? JSON.stringify(body) : undefined,
      signal : AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_MS * attempt);
      return cfRequest(method, path, token, body, attempt + 1);
    }
    return { ok: false, status: 503, data: { error: 'cloudflare_unreachable', message: err.message } };
  }

  // Rate-limited → retry with backoff
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
    await sleep(Math.max(RETRY_MS * attempt, retryAfter * 1000));
    return cfRequest(method, path, token, body, attempt + 1);
  }

  return { ok: res.ok, status: res.status, data };
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
function isAuthorized(req) {
  if (!API_SECRET) return true;                          // no secret set = open
  return req.headers['x-api-secret'] === API_SECRET;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth check
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // ── DELETE /api/warp ── удалить аккаунт WARP ─────────────────────────────
  if (req.method === 'DELETE') {
    const { account_id, token } = req.body ?? {};

    if (!account_id || !token) {
      return res.status(400).json({
        ok    : false,
        error : 'missing_fields',
        message: 'Both account_id and token are required',
      });
    }

    const result = await cfRequest('DELETE', `reg/${account_id}`, token);

    if (!result.ok) {
      return res.status(result.status).json({
        ok      : false,
        error   : 'cloudflare_error',
        cf_status: result.status,
        details : result.data,
      });
    }

    return res.status(200).json({ ok: true, message: 'account_deleted', account_id });
  }

  // ── GET / POST /api/warp ── создать новый конфиг ──────────────────────────
  if (req.method === 'GET' || req.method === 'POST') {

    // 1. Generate WireGuard keypair
    let keys;
    try {
      keys = generateWireGuardKeys();
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'keygen_failed', message: err.message });
    }

    // 2. Register account in WARP
    const tos    = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const regRes = await cfRequest('POST', 'reg', null, {
      install_id : '',
      tos,
      key        : keys.publicKey,
      fcm_token  : '',
      type       : 'ios',
      locale     : 'en_US',
    });

    if (!regRes.ok) {
      return res.status(regRes.status).json({
        ok       : false,
        error    : 'registration_failed',
        cf_status: regRes.status,
        details  : regRes.data,
      });
    }

    const account_id = regRes.data?.result?.id;
    const token      = regRes.data?.result?.token;

    if (!account_id || !token) {
      return res.status(502).json({
        ok     : false,
        error  : 'invalid_registration_response',
        details: regRes.data,
      });
    }

    // 3. Activate WARP on the account
    const activateRes = await cfRequest('PATCH', `reg/${account_id}`, token, {
      warp_enabled: true,
    });

    if (!activateRes.ok) {
      return res.status(activateRes.status).json({
        ok       : false,
        error    : 'activation_failed',
        cf_status: activateRes.status,
        details  : activateRes.data,
      });
    }

    // 4. Extract minimal fields needed to build a local WireGuard config
    const cfg            = activateRes.data?.result?.config;
    const peer_public_key = cfg?.peers?.[0]?.public_key;
    const client_ipv4    = cfg?.interface?.addresses?.v4;
    const client_ipv6    = cfg?.interface?.addresses?.v6;

    if (!peer_public_key || !client_ipv4) {
      return res.status(502).json({
        ok     : false,
        error  : 'incomplete_config',
        details: activateRes.data,
      });
    }

    // 5. Return everything the client needs to build the config locally
    return res.status(200).json({
      ok             : true,
      private_key    : keys.privateKey,    // client puts this in [Interface] PrivateKey
      peer_public_key,                     // client puts this in [Peer] PublicKey
      client_ipv4,                         // [Interface] Address (v4)
      client_ipv6,                         // [Interface] Address (v6)
      account_id,                          // stored client-side for future DELETE
      token,                               // stored client-side for future DELETE
    });
  }

  // Any other method
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
};
