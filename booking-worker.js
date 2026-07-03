/**
 * 經絡調理 — 預約 / 方案點數 API 閘道（Cloudflare Worker）
 * ───────────────────────────────────────────────────────────
 * 角色：客戶端 LIFF 不直接連 Firestore；一律經過這個 Worker。
 *  - 驗證 LINE 身分（id token）取得 userId
 *  - 用 Firebase 服務帳號（REST）讀寫 Firestore
 *  - 只回傳「非敏感」資料給客戶（剩餘次數、可約時段、我的預約）
 *  - 持有 LINE Channel token，負責推播
 *
 * 部署：Cloudflare Workers（免費方案足夠）。建議子網域如
 *   booking-api.a0985180305.workers.dev
 * 與現有 ai-proxy 分開，互不影響。
 *
 * 需在 Worker 設定以下「環境變數 / Secret」（見檔尾 SETUP 註解）：
 *   FIREBASE_PROJECT_ID          = "relax-clinic"
 *   FIREBASE_CLIENT_EMAIL        = 服務帳號 email
 *   FIREBASE_PRIVATE_KEY         = 服務帳號私鑰（含 \n）
 *   LINE_CHANNEL_ID              = LINE Login / Messaging channel id（驗證 id token 用）
 *   LINE_CHANNEL_ACCESS_TOKEN    = Messaging API channel access token（推播用）
 *   THERAPIST_SHARED_SECRET      = 後台 index.html 呼叫推播時的共享密鑰
 *   ALLOWED_ORIGIN               = LIFF 頁所在網域（CORS），如 https://xxx.pages.dev
 *
 * 方案設定（次數與效期月數）集中在 PLAN_CONFIG，可自行調整。
 */

const PLAN_CONFIG = {
  // type: { 總次數, 效期月數 }
  a10: { label: '買10送2', total: 12, months: 1 },    // 共 12 次，效期 1 個月
  b20: { label: '買20送6', total: 26, months: 1.5 },  // 共 26 次，效期 1.5 個月
  c30: { label: '買30送10', total: 40, months: 2 },   // 共 40 次，效期 2 個月
};

const SESSION_MINUTES = 50;

// ───────────────────────────── 進入點 ─────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    if (request.method !== 'POST') return cors(env, json({ error: 'method' }, 405));

    let body;
    try { body = await request.json(); } catch { return cors(env, json({ error: 'bad json' }, 400)); }
    const action = body.action;

    try {
      // 後台（調理師）專用：以共享密鑰授權，負責推播
      if (action === 'push') {
        requireSecret(body, env);
        await linePush(env, body.lineUserId, body.message);
        return cors(env, json({ ok: true }));
      }

      // 以下皆客戶端：需 LINE 身分
      const userId = await verifyLineUser(env, body.idToken);

      switch (action) {
        case 'me':            return cors(env, json(await handleMe(env, userId)));
        case 'bindByPhone':   return cors(env, json(await handleBindByPhone(env, userId, body.phone, body.name)));
        case 'bindByToken':   return cors(env, json(await handleBindByToken(env, userId, body.bindToken)));
        case 'availability':  return cors(env, json(await handleAvailability(env, userId, body.therapist, body.fromDate, body.days)));
        case 'book':          return cors(env, json(await handleBook(env, userId, body.therapist, body.start)));
        case 'myBookings':    return cors(env, json(await handleMyBookings(env, userId)));
        case 'cancelBooking': return cors(env, json(await handleCancel(env, userId, body.bookingId)));
        default:              return cors(env, json({ error: 'unknown action' }, 400));
      }
    } catch (e) {
      return cors(env, json({ error: String(e.message || e) }, e.status || 500));
    }
  },
};

// ───────────────────────────── 客戶動作 ─────────────────────────────

// 取得自己的綁定狀態與方案（非敏感）
async function handleMe(env, userId) {
  const client = await findClientByLineUser(env, userId);
  if (!client) return { bound: false };
  const packages = activePackages(client.fields.packages);
  return {
    bound: true,
    name: getStr(client.fields.name),
    clientId: client.id,
    therapist: getStr(client.fields.therapist),
    packages,
    totalRemaining: packages.reduce((a, p) => a + p.remaining, 0),
  };
}

// 用電話比對既有客戶 → 綁定 lineUserId
async function handleBindByPhone(env, userId, phone, name) {
  if (!phone) throw httpErr(400, '請輸入電話');
  const already = await findClientByLineUser(env, userId);
  if (already) return { bound: true, name: getStr(already.fields.name) };

  const norm = normPhone(phone);
  const matches = await runQuery(env, 'clients', [
    fieldFilter('contact', 'EQUAL', strVal(phone)),
  ]).catch(() => []);
  // contact 欄位可能含「電話 / LINE」混填，做寬鬆比對
  let target = matches.find(Boolean);
  if (!target) {
    const all = await runQuery(env, 'clients', []);
    target = all.find(c => normPhone(getStr(c.fields.contact)).includes(norm) && norm.length >= 8);
  }
  if (!target) throw httpErr(404, '查無此電話的客戶資料，請確認或聯繫調理師');
  if (getStr(target.fields.lineUserId)) throw httpErr(409, '此客戶已綁定其他 LINE 帳號，請聯繫調理師');

  await patchDoc(env, `clients/${target.id}`, { lineUserId: strVal(userId) }, ['lineUserId']);
  return { bound: true, name: getStr(target.fields.name) };
}

// 用調理師發的一次性連結 bindToken 綁定
async function handleBindByToken(env, userId, token) {
  if (!token) throw httpErr(400, '連結無效');
  const t = await getDoc(env, `bindTokens/${token}`).catch(() => null);
  if (!t) throw httpErr(404, '連結不存在或已失效');
  if (getBool(t.fields.used)) throw httpErr(409, '此連結已被使用');
  const exp = getStr(t.fields.expiresAt);
  if (exp && new Date(exp) < new Date()) throw httpErr(410, '連結已過期');
  const clientId = getStr(t.fields.clientId);
  if (!clientId) throw httpErr(400, '連結資料不完整');

  await patchDoc(env, `clients/${clientId}`, { lineUserId: strVal(userId) }, ['lineUserId']);
  await patchDoc(env, `bindTokens/${token}`, { used: { booleanValue: true }, usedBy: strVal(userId) }, ['used', 'usedBy']);
  const c = await getDoc(env, `clients/${clientId}`);
  return { bound: true, name: getStr(c.fields.name) };
}

// 某調理師未來 N 天的可約時段
async function handleAvailability(env, userId, therapist, fromDate, days) {
  if (!therapist) throw httpErr(400, '請選擇調理師');
  days = Math.min(Math.max(parseInt(days || 14, 10), 1), 60);
  const start = fromDate ? new Date(fromDate + 'T00:00:00+08:00') : startOfTodayTW();

  const template = await getDoc(env, `scheduleTemplate/${therapist}`).catch(() => null);
  const weekly = template ? parseWeekly(template.fields) : {};

  // 只用等於條件查詢（免複合索引），時間範圍在記憶體過濾。
  const booked = await runQuery(env, 'bookings', [
    fieldFilter('therapist', 'EQUAL', strVal(therapist)),
    fieldFilter('status', 'EQUAL', strVal('confirmed')),
  ], { compositeOp: 'AND' }).catch(() => []);
  const bookedSet = new Set(booked.map(b => getStr(b.fields.start)));

  const result = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    const dateStr = twDateStr(day);
    const dow = twDow(day); // 0=Sun..6=Sat
    const override = await getDoc(env, `scheduleOverride/${therapist}_${dateStr}`).catch(() => null);
    // 單日覆寫：存在 slots 欄位時，當日可約時段＝slots（絕對指定；空陣列＝當日休診）。
    // 否則沿用每週固定班表。
    let times;
    if (override && getArr(override.fields.slots) !== null) {
      times = getArr(override.fields.slots).map(getStr).filter(Boolean);
    } else {
      times = (weekly[dow] || []).slice();
    }
    times = [...new Set(times)].sort();
    const slots = times.map(hhmm => {
      const iso = twSlotIso(dateStr, hhmm);
      return { time: hhmm, start: iso, available: !bookedSet.has(iso) && new Date(iso) > new Date() };
    }).filter(s => s.start);
    if (slots.length) result.push({ date: dateStr, dow, slots });
  }
  return { therapist, days: result };
}

// 預約（原子鎖位）：doc id = {therapist}_{ISO} 已存在則失敗 ＝ 已被約
async function handleBook(env, userId, therapist, startIso) {
  if (!therapist || !startIso) throw httpErr(400, '資料不完整');
  const client = await findClientByLineUser(env, userId);
  if (!client) throw httpErr(403, '尚未綁定客戶資料');
  const start = new Date(startIso);
  if (isNaN(start) || start <= new Date()) throw httpErr(400, '時段無效或已過期');

  const docId = `${therapist}_${startIso}`;
  const endIso = new Date(start.getTime() + SESSION_MINUTES * 60000).toISOString();
  // 注意：start/end 以「字串」儲存（ISO 字典序＝時間序），與後台 index.html 的字串查詢一致
  const fields = {
    clientId: strVal(client.id),
    lineUserId: strVal(userId),
    clientName: strVal(getStr(client.fields.name)),
    therapist: strVal(therapist),
    start: strVal(startIso),
    end: strVal(endIso),
    status: strVal('confirmed'),
    createdAt: strVal(new Date().toISOString()),
  };
  // 條件式建立：文件不存在才寫入（防搶位）
  const ok = await createIfAbsent(env, `bookings/${docId}`, fields);
  if (!ok) throw httpErr(409, '這個時段剛剛被預約走了，請選其他時段');
  return { ok: true, bookingId: docId, start: startIso, therapist };
}

async function handleMyBookings(env, userId) {
  const nowIso = new Date().toISOString();
  const rows = await runQuery(env, 'bookings', [
    fieldFilter('lineUserId', 'EQUAL', strVal(userId)),
  ]).catch(() => []);
  const bookings = rows
    .filter(r => getStr(r.fields.start) >= nowIso)
    .filter(r => ['confirmed', 'declined'].includes(getStr(r.fields.status)))
    .map(r => ({
      bookingId: r.id,
      therapist: getStr(r.fields.therapist),
      start: getStr(r.fields.start),
      status: getStr(r.fields.status),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { bookings };
}

async function handleCancel(env, userId, bookingId) {
  if (!bookingId) throw httpErr(400, '缺少預約編號');
  const b = await getDoc(env, `bookings/${bookingId}`).catch(() => null);
  if (!b) throw httpErr(404, '預約不存在');
  if (getStr(b.fields.lineUserId) !== userId) throw httpErr(403, '無權取消此預約');
  if (new Date(getStr(b.fields.start)) <= new Date()) throw httpErr(400, '已過期的預約無法取消');
  await patchDoc(env, `bookings/${bookingId}`, {
    status: strVal('cancelled'),
    cancelledAt: { timestampValue: new Date().toISOString() },
  }, ['status', 'cancelledAt']);
  return { ok: true };
}

// ───────────────────────────── 工具：方案 ─────────────────────────────
function activePackages(packagesField) {
  const arr = getArr(packagesField) || [];
  const now = new Date();
  return arr.map(v => {
    const p = v.mapValue ? v.mapValue.fields : {};
    const type = getStr(p.type);
    const cfg = PLAN_CONFIG[type] || {};
    const total = getInt(p.totalSessions) || cfg.total || 0;
    const used = getInt(p.usedSessions) || 0;
    const expiry = getStr(p.expiryDate);
    return {
      type,
      label: cfg.label || type,
      total,
      used,
      remaining: Math.max(total - used, 0),
      purchaseDate: getStr(p.purchaseDate),
      expiryDate: expiry,
      expired: expiry ? new Date(expiry) < now : false,
    };
  }).filter(p => p.remaining > 0 && !p.expired);
}

// ───────────────────────────── 工具：班表 ─────────────────────────────
// scheduleTemplate/{therapist} 文件欄位：mon,tue,...sun 各是字串陣列 ["10:00","11:00",...]
function parseWeekly(fields) {
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const out = {};
  for (const [k, dow] of Object.entries(map)) {
    out[dow] = (getArr(fields[k]) || []).map(getStr).filter(Boolean);
  }
  return out;
}

// ───────────────────────────── LINE ─────────────────────────────
async function verifyLineUser(env, idToken) {
  if (!idToken) throw httpErr(401, '缺少身分權杖');
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_CHANNEL_ID }),
  });
  const data = await res.json();
  if (!res.ok || !data.sub) throw httpErr(401, 'LINE 身分驗證失敗');
  return data.sub; // LINE userId
}

async function linePush(env, to, message) {
  if (!to || !message) throw httpErr(400, '推播缺少對象或內容');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: String(message).slice(0, 4900) }] }),
  });
  if (!res.ok) throw httpErr(502, 'LINE 推播失敗：' + (await res.text()).slice(0, 200));
}

function requireSecret(body, env) {
  if (!env.THERAPIST_SHARED_SECRET || body.secret !== env.THERAPIST_SHARED_SECRET) {
    throw httpErr(401, '未授權');
  }
}

// ───────────────────────────── Firestore REST ─────────────────────────────
const FS_BASE = (env) => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function findClientByLineUser(env, userId) {
  const rows = await runQuery(env, 'clients', [fieldFilter('lineUserId', 'EQUAL', strVal(userId))]);
  return rows[0] || null;
}

async function getDoc(env, path) {
  const token = await googleToken(env);
  const res = await fetch(`${FS_BASE(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw httpErr(404, 'not found');
  if (!res.ok) throw httpErr(500, 'firestore get: ' + (await res.text()).slice(0, 200));
  const d = await res.json();
  return { id: path.split('/').pop(), fields: d.fields || {} };
}

async function runQuery(env, collection, filters, opts = {}) {
  const token = await googleToken(env);
  const where = filters.length === 0 ? undefined
    : filters.length === 1 ? filters[0]
    : { compositeFilter: { op: opts.compositeOp || 'AND', filters } };
  const body = { structuredQuery: { from: [{ collectionId: collection }], ...(where ? { where } : {}) } };
  const res = await fetch(`${FS_BASE(env)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpErr(500, 'firestore query: ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    fields: r.document.fields || {},
  }));
}

// 條件式建立（文件不存在才寫）— 用 commit + precondition exists:false
async function createIfAbsent(env, path, fields) {
  const token = await googleToken(env);
  const docName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [{ update: { name: docName, fields }, currentDocument: { exists: false } }],
      }),
    }
  );
  if (!res.ok) {
    const txt = await res.text(); // 只讀一次 body
    // 文件已存在（precondition exists:false 失敗）＝該時段已被預約 → 回 false 由上層提示
    if (res.status === 409 || /exist|already|FAILED_PRECONDITION/i.test(txt)) return false;
    throw httpErr(500, 'firestore create: ' + txt.slice(0, 200));
  }
  return true;
}

async function patchDoc(env, path, fields, updateMask) {
  const token = await googleToken(env);
  const mask = updateMask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw httpErr(500, 'firestore patch: ' + (await res.text()).slice(0, 200));
  return res.json();
}

// ── Google 服務帳號 → OAuth2 access token（RS256 JWT，WebCrypto） ──
let _tokenCache = { token: null, exp: 0 };
async function googleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp > now + 60) return _tokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw httpErr(500, 'Google token 失敗：' + JSON.stringify(data).slice(0, 200));
  _tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

async function importPrivateKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// ───────────────────────────── Firestore 值 helper ─────────────────────────────
function strVal(s) { return { stringValue: String(s == null ? '' : s) }; }
function fieldFilter(field, op, value) {
  return { fieldFilter: { field: { fieldPath: field }, op, value } };
}
function getStr(f) { return f && f.stringValue !== undefined ? f.stringValue : (f && f.timestampValue) || ''; }
function getInt(f) { if (!f) return 0; if (f.integerValue !== undefined) return parseInt(f.integerValue, 10); if (f.doubleValue !== undefined) return f.doubleValue; if (f.stringValue !== undefined) return parseInt(f.stringValue, 10) || 0; return 0; }
function getBool(f) { return !!(f && f.booleanValue); }
function getArr(f) { return f && f.arrayValue ? (f.arrayValue.values || []) : null; }

// ───────────────────────────── 日期（台灣時區 +08:00） ─────────────────────────────
function startOfTodayTW() {
  // 台灣（UTC+8，無日光節約）今天 00:00 對應的時間點
  return new Date(twDateStr(new Date()) + 'T00:00:00+08:00');
}
function twDateStr(d) {
  const tw = new Date(d.getTime() + 8 * 3600000);
  return tw.toISOString().slice(0, 10);
}
function twDow(d) {
  const tw = new Date(d.getTime() + 8 * 3600000);
  return tw.getUTCDay();
}
function twSlotIso(dateStr, hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return '';
  return new Date(`${dateStr}T${hhmm}:00+08:00`).toISOString();
}

// ───────────────────────────── HTTP helper ─────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function normPhone(s) { return String(s || '').replace(/[^0-9]/g, ''); }
