/**
 * Windsurf direct login — Firebase auth + Codeium registration.
 * Supports proxy tunneling and fingerprint randomization.
 */

import http from 'http';
import https from 'https';
import { log } from '../config.js';
import { parseFields, writeStringField } from '../proto.js';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_POST_AUTH_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const CODEIUM_REGISTER_URL = 'https://api.codeium.com/register_user/';

// ─── Fingerprint randomization ────────────────────────────

const OS_VERSIONS = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 10.0; WOW64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 11_6_0',
  'Macintosh; Intel Mac OS X 12_3_1',
  'Macintosh; Intel Mac OS X 13_4_1',
  'Macintosh; Intel Mac OS X 14_2_1',
  'X11; Linux x86_64',
  'X11; Ubuntu; Linux x86_64',
];

const CHROME_VERSIONS = [
  '120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0',
  '125.0.0.0', '126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0',
  '130.0.0.0', '131.0.0.0', '132.0.0.0', '133.0.0.0', '134.0.0.0',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9', 'en-GB,en;q=0.9', 'zh-TW,zh;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en-US;q=0.9,en;q=0.8',
  'ko,en-US;q=0.9,en;q=0.8', 'de,en-US;q=0.9,en;q=0.8',
  'fr,en-US;q=0.9,en;q=0.8', 'es,en-US;q=0.9,en;q=0.8',
  'pt-BR,pt;q=0.9,en;q=0.8',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateFingerprint() {
  const os = pick(OS_VERSIONS);
  const chromeVer = pick(CHROME_VERSIONS);
  const major = chromeVer.split('.')[0];
  const ua = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

  return {
    'User-Agent': ua,
    'Accept-Language': pick(ACCEPT_LANGUAGES),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': os.includes('Windows') ? '"Windows"' : os.includes('Mac') ? '"macOS"' : '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Origin': 'https://windsurf.com',
    'Referer': 'https://windsurf.com/',
  };
}

// ─── Proxy tunnel (HTTP CONNECT) ──────────────────────────

function createProxyTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.host.replace(/:\d+$/, '');
    const proxyPort = proxy.port || 8080;

    const authHeader = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
      : '';

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}` } : {}),
      },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
    });

    connectReq.on('error', (err) => reject(new Error(`Proxy connection error: ${err.message}`)));
    connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('Proxy connection timeout')); });
    connectReq.end();
  });
}

// ─── HTTPS request with optional proxy ────────────────────

function httpsRequest(url, opts, postData, proxy) {
  return new Promise(async (resolve, reject) => {
    const parsed = new URL(url);
    const requestOpts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'POST',
      headers: opts.headers || {},
    };

    const handleResponse = (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const rawBuf = Buffer.concat(bufs);
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        const accept = String(requestOpts.headers?.Accept || '').toLowerCase();
        const wantsProto = accept.includes('application/proto') || accept.includes('application/octet-stream');
        if (wantsProto || contentType.includes('application/proto') || contentType.includes('application/octet-stream')) {
          resolve({ status: res.statusCode, data: rawBuf });
          return;
        }
        const raw = rawBuf.toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new Error(`Parse error (status ${res.statusCode}, encoding ${res.headers['content-encoding'] || 'identity'}): ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    };

    try {
      let req;
      if (proxy && proxy.host) {
        const socket = await createProxyTunnel(proxy, parsed.hostname, 443);
        requestOpts.socket = socket;
        requestOpts.agent = false;
        req = https.request(requestOpts, handleResponse);
      } else {
        req = https.request(requestOpts, handleResponse);
      }

      req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

function extractPostAuthFields(buf) {
  const fields = parseFields(buf);
  let apiKey = '';
  let accountId = '';
  let orgId = '';

  for (const field of fields) {
    if (field.wireType !== 2) continue;
    const value = field.value.toString('utf8');
    if (field.field === 1 && value.startsWith('devin-session-token$')) apiKey = value;
    if (field.field === 4 && value.startsWith('account-')) accountId = value;
    if (field.field === 5 && value.startsWith('org-')) orgId = value;
  }

  return { apiKey, accountId, orgId };
}


/**
 * Full Windsurf login: password login → WindsurfPostAuth → API key.
 * @param {string} email
 * @param {string} password
 * @param {object} [proxy] - { host, port, username, password }
 * @returns {{ apiKey, name, email, token, userId, accountId, orgId }}
 */
export async function windsurfLogin(email, password, proxy = null) {
  const fingerprint = generateFingerprint();
  log.info(`Windsurf login: ${email} fp=${fingerprint['User-Agent'].slice(0, 40)}... proxy=${proxy?.host || 'none'}`);

  const loginBody = JSON.stringify({ email, password });
  const loginHeaders = {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(loginBody),
  };

  const loginRes = await httpsRequest(PASSWORD_LOGIN_URL, { method: 'POST', headers: loginHeaders }, loginBody, proxy);
  if (loginRes.status >= 400) {
    const msg = loginRes.data?.error || loginRes.data?.message || JSON.stringify(loginRes.data).slice(0, 200);
    throw new Error(`Windsurf 登录失败: ${msg}`);
  }

  const token = loginRes.data?.token;
  const userId = loginRes.data?.user_id || '';
  const loginEmail = loginRes.data?.email || email;
  if (!token) throw new Error(`Windsurf 登录成功但缺少 token: ${JSON.stringify(loginRes.data).slice(0, 200)}`);

  const postAuthBody = writeStringField(1, token);
  const postAuthHeaders = {
    ...fingerprint,
    'Content-Type': 'application/proto',
    'Accept': 'application/proto',
    'Content-Length': postAuthBody.length,
  };

  const postAuthRes = await httpsRequest(WINDSURF_POST_AUTH_URL, { method: 'POST', headers: postAuthHeaders }, postAuthBody, proxy);
  if (postAuthRes.status >= 400 || !Buffer.isBuffer(postAuthRes.data)) {
    const preview = Buffer.isBuffer(postAuthRes.data)
      ? postAuthRes.data.toString('utf8', 0, 200)
      : JSON.stringify(postAuthRes.data).slice(0, 200);
    throw new Error(`Windsurf PostAuth 失败: ${preview}`);
  }

  const { apiKey, accountId, orgId } = extractPostAuthFields(postAuthRes.data);
  if (!apiKey) throw new Error('Windsurf PostAuth 成功但未返回 devin-session-token');

  log.info(`Windsurf login OK: ${loginEmail}, user=${userId || 'unknown'} account=${accountId || 'unknown'}`);

  return {
    apiKey,
    name: loginEmail,
    email: loginEmail,
    token,
    userId,
    accountId,
    orgId,
    refreshToken: '',
    apiServerUrl: '',
  };
}

/**
 * Refresh a Firebase ID token using a stored refresh token.
 * Returns a new { idToken, refreshToken, expiresIn } or throws.
 *
 * @param {string} refreshToken
 * @param {object} [proxy]
 * @returns {Promise<{idToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshFirebaseToken(refreshToken, proxy = null) {
  if (!refreshToken) throw new Error('No refresh token available');

  const postBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postBody),
    'Referer': 'https://windsurf.com/',
    'Origin': 'https://windsurf.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  };

  const res = await httpsRequest(FIREBASE_REFRESH_URL, { method: 'POST', headers }, postBody, proxy);

  if (res.data?.error) {
    const msg = res.data.error.message || res.data.error.code || 'Unknown error';
    throw new Error(`Firebase token refresh failed: ${msg}`);
  }

  const newIdToken = res.data?.id_token || res.data?.idToken;
  const newRefreshToken = res.data?.refresh_token || res.data?.refreshToken || refreshToken;
  const expiresIn = parseInt(res.data?.expires_in || res.data?.expiresIn || '3600', 10);

  if (!newIdToken) {
    throw new Error(`Firebase token refresh: no idToken in response: ${JSON.stringify(res.data).slice(0, 200)}`);
  }

  log.info(`Firebase token refreshed, expires in ${expiresIn}s`);
  return { idToken: newIdToken, refreshToken: newRefreshToken, expiresIn };
}

/**
 * Re-register with Codeium using a refreshed Firebase token.
 * Returns a fresh API key (may be the same key if unchanged).
 *
 * @param {string} idToken - fresh Firebase ID token
 * @param {object} [proxy]
 * @returns {Promise<{apiKey: string, name: string}>}
 */
export async function reRegisterWithCodeium(idToken, proxy = null) {
  const fingerprint = generateFingerprint();
  const regBody = JSON.stringify({ firebase_id_token: idToken });
  const regHeaders = {
    ...fingerprint,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(regBody),
  };

  const regRes = await httpsRequest(CODEIUM_REGISTER_URL, { method: 'POST', headers: regHeaders }, regBody, proxy);

  if (regRes.status >= 400 || !regRes.data.api_key) {
    throw new Error(`Codeium re-registration failed: ${JSON.stringify(regRes.data).slice(0, 200)}`);
  }

  return {
    apiKey: regRes.data.api_key,
    name: regRes.data.name || '',
  };
}
