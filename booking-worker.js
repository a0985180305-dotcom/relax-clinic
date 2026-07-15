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
const BUFFER_MINUTES = 20;  // 任一預約與前後既有預約固定間隔（需求書 §1）
const THERAPIST_NAME = { glan: '神藏', xuan: '神庭' }; // 對客戶顯示用代號（鈞=神藏、萱=神庭）
// Google 日曆顏色 id：神藏＝薰衣草(1)、神庭＝藍莓(9)。待確認階段不上色（南瓜黃擱置）。
const CAL_COLOR = { glan: '1', xuan: '9' };

// ───────────────────────────── 進入點 ─────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    // 公開 GET：加入行事曆 .ics（純參數產生，不查資料庫、不含姓名）
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/ics') return icsResponse(url.searchParams);
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

      // 後台專用：核准/拒絕時同步 Google 日曆（confirm＝去前綴+上色；remove＝刪事件）
      if (action === 'adminCalendar') {
        requireSecret(body, env);
        return cors(env, json(await handleAdminCalendar(env, body.op, body.bookingId)));
      }

      // 後台專用：讀「B 場地」行事曆某個月的事件（產生給客戶的時間表圖）
      if (action === 'bMonth') {
        requireSecret(body, env);
        return cors(env, json(await handleBMonth(env, body.year, body.month)));
      }

      // 以下皆客戶端：需 LINE 身分
      const userId = await verifyLineUser(env, body.idToken);

      switch (action) {
        case 'me':            return cors(env, json(await handleMe(env, userId)));
        case 'bindByPhone':   return cors(env, json(await handleBindByPhone(env, userId, body.phone, body.name)));
        case 'bindByToken':   return cors(env, json(await handleBindByToken(env, userId, body.bindToken)));
        case 'selfRegister':  return cors(env, json(await handleSelfRegister(env, userId, body.profile || {})));
        case 'requestHelp':   return cors(env, json(await handleRequestHelp(env, userId, body.profile || {})));
        case 'availability':  return cors(env, json(await handleAvailability(env, userId, body.therapist, body.fromDate, body.days, body.sessions)));
        case 'book':          return cors(env, json(await handleBook(env, userId, body.therapist, body.start, body.sessions, body.extras, body.extrasOther)));
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
    lastExtras: (getArr(client.fields.lastExtras) || []).map(getStr).filter(Boolean),
    lastExtrasOther: getStr(client.fields.lastExtrasOther),
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

// 新客自助建檔（查無電話時）：先用電話查重，查到就綁定既有檔（避免重複病歷），
// 查無才新建一筆 clients（標記 source=自助待確認，供調理師後台過目）。
async function handleSelfRegister(env, userId, p) {
  const already = await findClientByLineUser(env, userId);
  if (already) return { bound: true, name: getStr(already.fields.name), matched: true };

  const name = String(p.name || '').trim();
  const phone = String(p.phone || '').trim();
  if (!name) throw httpErr(400, '請填寫姓名');
  if (!phone) throw httpErr(400, '請填寫電話');

  // 查重：電話對得上既有客戶 → 直接綁定，不新建
  const dup = await findClientByPhone(env, phone);
  if (dup) {
    if (getStr(dup.fields.lineUserId)) throw httpErr(409, '這支電話已有客戶資料且綁定其他 LINE，請改用「請專人協助」');
    await patchDoc(env, `clients/${dup.id}`, { lineUserId: strVal(userId) }, ['lineUserId']);
    return { bound: true, name: getStr(dup.fields.name), matched: true };
  }

  // 查無 → 新建正式病歷（標記待確認）
  const fields = {
    name: strVal(name),
    contact: strVal(phone),
    gender: strVal(p.gender),
    birthday: strVal(p.birthday),
    age: strVal(ageFromBirthday(p.birthday)),
    avoid: strVal(p.avoid),          // 不想／不方便被碰的部位（與禁忌分開）
    contra: strVal(p.contra),        // 禁忌／特殊注意事項
    history: strVal(p.history),      // 手術史＋身體狀況勾選（客戶端已彙整成文字）
    therapist: strVal(''),           // 負責調理師由調理師後台指派
    source: strVal('自助待確認'),
    lineUserId: strVal(userId),
    sessions: { arrayValue: { values: [] } },
    createdAt: strVal(new Date().toISOString()),
  };
  const newId = await createDoc(env, 'clients', fields);

  // 通知調理師有新客自助建檔（只帶姓名／電話，病歷不進推播）
  try {
    await notifyAdmins(env,
      `🆕 新客自助建檔（待確認）\n姓名：${name}\n電話：${phone}\n請至後台客戶列表過目、指派調理師。`);
  } catch (e) {}
  return { bound: true, name, clientId: newId, created: true };
}

// 新客選「請專人協助」：只推播姓名／電話給調理師回撥，不建檔、不帶病歷
async function handleRequestHelp(env, userId, p) {
  const name = String(p.name || '').trim();
  const phone = String(p.phone || '').trim();
  try {
    await notifyAdmins(env,
      `🙋 新客請求專人協助建檔\n姓名：${name || '（未填）'}\n電話：${phone || '（未填）'}\n請主動聯繫這位客戶協助建檔。`);
  } catch (e) { throw httpErr(502, '通知調理師失敗，請稍後再試或直接來電'); }
  return { ok: true };
}

// 某調理師未來 N 天的可約時段（依節數過濾：塞得下整段＋前後緩衝才顯示）
async function handleAvailability(env, userId, therapist, fromDate, days, sessionsRaw) {
  if (!therapist) throw httpErr(400, '請選擇調理師');
  days = Math.min(Math.max(parseInt(days || 14, 10), 1), 60);
  const sessions = Math.min(Math.max(parseInt(sessionsRaw || 1, 10) || 1, 1), 2); // Phase 1 支援 1–2 節
  const dur = sessions * SESSION_MINUTES;
  const start = fromDate ? new Date(fromDate + 'T00:00:00+08:00') : startOfTodayTW();

  const template = await getDoc(env, `scheduleTemplate/${therapist}`).catch(() => null);
  const weekly = template ? parseWeekly(template.fields) : {};

  // 只撈「今日 00:00（台灣）以後」的預約參與衝突判定，省讀取。
  // 需 Firestore 複合索引：bookings 的 therapist(升冪)＋start(升冪)。
  const todayIso = startOfTodayTW().toISOString();
  const booked = await runQuery(env, 'bookings', [
    fieldFilter('therapist', 'EQUAL', strVal(therapist)),
    fieldFilter('start', 'GREATER_THAN_OR_EQUAL', strVal(todayIso)),
  ]).catch(() => []);
  const busy = buildBusy(booked);

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
    // 隱私：塞不下（撞既有預約±20分、跨午休、超過21:00）、已過期、
    // 或已過線上預約截止（隔日時段每天21:00關）的時段直接不送出，
    // 客戶端看不到、也推不出店內的預約狀況。
    const slots = times.map(hhmm => {
      const iso = twSlotIso(dateStr, hhmm);
      return { time: hhmm, start: iso, available: true };
    }).filter(s => s.start && new Date(s.start) > new Date() && !bookingClosed(s.start) && fitsRules(new Date(s.start).getTime(), dur, busy));
    if (slots.length) result.push({ date: dateStr, dow, slots });
  }
  return { therapist, days: result };
}

// 預約（原子鎖位）：doc id = {therapist}_{ISO} 已存在則失敗 ＝ 已被約
// 狀態機：送出＝pending（待確認、時段即時鎖定），管理員核准後才 confirmed。
async function handleBook(env, userId, therapist, startIso, sessionsRaw, extrasRaw, extrasOther) {
  if (!therapist || !startIso) throw httpErr(400, '資料不完整');
  const client = await findClientByLineUser(env, userId);
  if (!client) throw httpErr(403, '尚未綁定客戶資料');
  const start = new Date(startIso);
  if (isNaN(start) || start <= new Date()) throw httpErr(400, '時段無效或已過期');
  if (bookingClosed(startIso)) throw httpErr(400, '這個時段的線上預約已截止（每天 21:00 起關閉隔日時段），請直接聯繫調理師');
  const sessions = Math.min(Math.max(parseInt(sessionsRaw || 1, 10) || 1, 1), 2); // Phase 1 支援 1–2 節
  const extras = Array.isArray(extrasRaw) ? extrasRaw.map(x => String(x)).filter(Boolean).slice(0, 20) : [];
  const extraOther = String(extrasOther || '').trim().slice(0, 200);
  const extrasText = [...extras, extraOther ? `其他：${extraOther}` : ''].filter(Boolean).join('、');

  // 送出當下重新驗證：整段（含前後 20 分緩衝）塞得下、不跨午休、不超過 21:00。
  // 防止客戶停在舊畫面點選早已不符的時段。
  const rows = await runQuery(env, 'bookings', [
    fieldFilter('therapist', 'EQUAL', strVal(therapist)),
  ]).catch(() => []);
  if (!fitsRules(start.getTime(), sessions * SESSION_MINUTES, buildBusy(rows))) {
    throw httpErr(409, '這個時段剛剛被預約走了，或無法容納所選節數，請重新選擇');
  }

  const docId = `${therapist}_${startIso}`;
  const endIso = new Date(start.getTime() + sessions * SESSION_MINUTES * 60000).toISOString();
  // 注意：start/end 以「字串」儲存（ISO 字典序＝時間序），與後台 index.html 的字串查詢一致
  const fields = {
    clientId: strVal(client.id),
    lineUserId: strVal(userId),
    clientName: strVal(getStr(client.fields.name)),
    therapist: strVal(therapist),
    start: strVal(startIso),
    end: strVal(endIso),
    sessions: { integerValue: String(sessions) },
    extras: { arrayValue: { values: extras.map(strVal) } },   // 本次補充項目（服裝/電熱毯/毛巾…）
    extrasOther: strVal(extraOther),
    groupId: { nullValue: null },    // 預留：雙人同行群組綁定（Phase 3）
    groupRole: { nullValue: null },  // 預留：primary／companion（Phase 3）
    status: strVal('pending'),
    createdAt: strVal(new Date().toISOString()),
  };
  // 條件式建立：文件不存在才寫入（防搶位）
  const ok = await createIfAbsent(env, `bookings/${docId}`, fields);
  if (!ok) throw httpErr(409, '這個時段剛剛被預約走了，請選其他時段');

  // 記住本次補充選項到客戶檔，下次預約自動帶入（失敗不影響預約）
  try {
    await patchDoc(env, `clients/${client.id}`,
      { lastExtras: { arrayValue: { values: extras.map(strVal) } }, lastExtrasOther: strVal(extraOther) },
      ['lastExtras', 'lastExtrasOther']);
  } catch (e) {}

  // 在「鈞&萱」日曆建【待確認】事件（失敗不影響預約成立，只是日曆少一筆）
  try {
    const name = getStr(client.fields.name);
    const evId = await calCreate(env, {
      summary: `【待確認】${name}`,
      description: `系統線上預約（待核准）\n調理師：${THERAPIST_NAME[therapist] || therapist}\n節數：${sessions} 節（${sessions * SESSION_MINUTES} 分鐘）\n客戶：${name}${extrasText ? '\n補充：' + extrasText : ''}`,
      startIso, endIso,
    });
    if (evId) await patchDoc(env, `bookings/${docId}`, { calendarEventId: strVal(evId) }, ['calendarEventId']);
  } catch (e) {}

  // 即時推播兩位管理員（推播失敗不影響預約成立，後台待核准清單是備援）
  let adminNotified = true;
  try {
    await notifyAdmins(env,
      `🔔 新預約待核准\n客戶：${getStr(client.fields.name)}\n調理師：${THERAPIST_NAME[therapist] || therapist}\n時間：${twDateTimeStr(start)}\n節數：${sessions} 節（${sessions * SESSION_MINUTES} 分鐘）${extrasText ? '\n補充：' + extrasText : ''}\n\n👉 點此開後台核准／拒絕：\nhttps://a0985180305-dotcom.github.io/relax-clinic/?screen=bookings`);
  } catch (e) { adminNotified = false; }
  return { ok: true, bookingId: docId, start: startIso, therapist, status: 'pending', adminNotified };
}

async function handleMyBookings(env, userId) {
  const nowIso = new Date().toISOString();
  const rows = await runQuery(env, 'bookings', [
    fieldFilter('lineUserId', 'EQUAL', strVal(userId)),
  ]).catch(() => []);
  const bookings = rows
    .filter(r => getStr(r.fields.start) >= nowIso)
    .filter(r => ['pending', 'confirmed', 'declined'].includes(getStr(r.fields.status)))
    .map(r => ({
      bookingId: r.id,
      therapist: getStr(r.fields.therapist),
      start: getStr(r.fields.start),
      status: getStr(r.fields.status),
      sessions: getInt(r.fields.sessions) || 1,
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
  if (Date.now() >= dayBefore21Ms(getStr(b.fields.start))) throw httpErr(400, '距離預約已不到一天（前一日 21:00 後不可自行取消），請直接聯繫調理師');
  // 先刪日曆事件（失敗不影響取消本身）
  const evId = getStr(b.fields.calendarEventId);
  if (evId) { try { await calDelete(env, evId); } catch (e) {} }
  // 搬移文件（換 id）而非原地改狀態：doc id 本身就是時段鎖，
  // 搬走後同一時段才能重新被預約（原地改 status 會讓該時段永遠卡死）。
  await moveDoc(env, `bookings/${bookingId}`, `bookings/${bookingId}~cx${Date.now()}`, {
    status: strVal('cancelled'),
    cancelledAt: strVal(new Date().toISOString()),
  });
  // 即時通知管理員時段已釋出（通知失敗不影響取消本身）
  try {
    await notifyAdmins(env,
      `❎ 客戶取消預約\n客戶：${getStr(b.fields.clientName)}\n調理師：${THERAPIST_NAME[getStr(b.fields.therapist)] || ''}\n時間：${twDateTimeStr(new Date(getStr(b.fields.start)))}\n該時段已重新開放。`);
  } catch (e) {}
  return { ok: true };
}

// 後台核准/拒絕時同步日曆：confirm＝標題去【待確認】+上調理師顏色；remove＝刪事件
async function handleAdminCalendar(env, op, bookingId) {
  if (!bookingId) throw httpErr(400, '缺少預約編號');
  const b = await getDoc(env, `bookings/${bookingId}`).catch(() => null);
  if (!b) return { ok: true, skipped: '預約不存在' };
  const evId = getStr(b.fields.calendarEventId);
  if (!evId) return { ok: true, skipped: '此預約無日曆事件' };

  if (op === 'confirm') {
    const therapist = getStr(b.fields.therapist);
    const name = getStr(b.fields.clientName);
    const sessions = getInt(b.fields.sessions) || 1;
    await calPatch(env, evId, {
      summary: name,
      colorId: CAL_COLOR[therapist] || null,
      description: `系統線上預約（已確認）\n調理師：${THERAPIST_NAME[therapist] || therapist}\n節數：${sessions} 節（${sessions * SESSION_MINUTES} 分鐘）\n客戶：${name}`,
    });
    return { ok: true };
  }
  if (op === 'remove') {
    await calDelete(env, evId);
    return { ok: true };
  }
  throw httpErr(400, '未知的日曆操作');
}

// 後台專用：讀 B 場地行事曆某個月的事件（回原始事件，姓名過濾在後台端做）
async function handleBMonth(env, year, month) {
  const y = parseInt(year, 10), m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) throw httpErr(400, '月份無效');
  const pad = n => String(n).padStart(2, '0');
  const timeMin = `${y}-${pad(m)}-01T00:00:00+08:00`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const timeMax = `${ny}-${pad(nm)}-01T00:00:00+08:00`;
  const events = await calList(env, env.GOOGLE_CALENDAR_ID_B, timeMin, timeMax);
  return { year: y, month: m, events };
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

// ───────────────────────────── 工具：時段規則 ─────────────────────────────
// 佔用區間：待確認／已確認／已完成的預約，各佔 [start, end)
function buildBusy(rows) {
  return rows
    .filter(b => ['pending', 'confirmed', 'completed'].includes(getStr(b.fields.status)))
    .map(b => {
      const s = new Date(getStr(b.fields.start)).getTime();
      const eStr = getStr(b.fields.end);
      return [s, eStr ? new Date(eStr).getTime() : s + SESSION_MINUTES * 60000];
    });
}
// 硬規則檢查：整段落在營業時間（07:00–12:00／14:00–21:00，不跨午休），
// 且與所有既有預約前後保持 20 分鐘緩衝。
function fitsRules(startMs, durMin, busy) {
  if (isNaN(startMs)) return false;
  const endMs = startMs + durMin * 60000;
  const tw = new Date(startMs + 8 * 3600000);
  const startMin = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  const endMin = startMin + durMin;
  const morning = startMin >= 7 * 60 && endMin <= 12 * 60;
  const evening = startMin >= 14 * 60 && endMin <= 21 * 60;
  if (!morning && !evening) return false;
  const buf = BUFFER_MINUTES * 60000;
  for (const [bs, be] of busy) {
    if (startMs - buf < be && bs < endMs + buf) return false;
  }
  return true;
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

// 推播兩位管理員（multicast，一次計 1 則/人）。
// 名單優先讀 Firestore config/app.adminUserIds（陣列或逗號字串），
// 讀不到再退回 Worker 環境變數 ADMIN_USER_IDS（逗號分隔）。
async function notifyAdmins(env, text) {
  const ids = await adminUserIds(env);
  if (!ids.length) throw httpErr(500, '未設定管理員 LINE 名單（config/app.adminUserIds）');
  const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: ids, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
  });
  if (!res.ok) throw httpErr(502, 'LINE 管理員推播失敗：' + (await res.text()).slice(0, 200));
}

async function adminUserIds(env) {
  try {
    const c = await getDoc(env, 'config/app');
    const arr = getArr(c.fields.adminUserIds);
    if (arr) {
      const ids = arr.map(getStr).filter(Boolean);
      if (ids.length) return ids;
    }
    const s = getStr(c.fields.adminUserIds);
    if (s) return s.split(',').map(x => x.trim()).filter(Boolean);
  } catch (e) {}
  return String(env.ADMIN_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
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

// 用電話查既有客戶（先精確比對 contact，再寬鬆比對數字子字串）。查無回 null。
async function findClientByPhone(env, phone) {
  const exact = await runQuery(env, 'clients', [fieldFilter('contact', 'EQUAL', strVal(phone))]).catch(() => []);
  if (exact[0]) return exact[0];
  const norm = normPhone(phone);
  if (norm.length < 8) return null;
  const all = await runQuery(env, 'clients', []).catch(() => []);
  return all.find(c => normPhone(getStr(c.fields.contact)).includes(norm)) || null;
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

// 建立文件（自動產生 id）— 回傳新文件 id。
async function createDoc(env, collection, fields) {
  const token = await googleToken(env);
  const res = await fetch(`${FS_BASE(env)}/${collection}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw httpErr(500, 'firestore create doc: ' + (await res.text()).slice(0, 200));
  const d = await res.json();
  return d.name ? d.name.split('/').pop() : null;
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

// 原子搬移文件（同一個 commit：新 id 建立＋舊 id 刪除）。
// 用於取消/拒絕：doc id 是時段鎖，必須搬走該時段才能重新開放預約。
async function moveDoc(env, fromPath, toPath, extraFields) {
  const token = await googleToken(env);
  const src = await getDoc(env, fromPath);
  const base = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(`https://firestore.googleapis.com/v1/${base}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        { update: { name: `${base}/${toPath}`, fields: { ...src.fields, ...extraFields } }, currentDocument: { exists: false } },
        { delete: `${base}/${fromPath}` },
      ],
    }),
  });
  if (!res.ok) throw httpErr(500, 'firestore move: ' + (await res.text()).slice(0, 200));
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

// ───────────────────────────── Google 日曆 REST ─────────────────────────────
const CAL_BASE = (env) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;

async function calCreate(env, { summary, description, startIso, endIso }) {
  if (!env.GOOGLE_CALENDAR_ID) return null; // 未設定日曆 ID → 靜默略過（不阻擋預約）
  const token = await googleToken(env);
  const res = await fetch(CAL_BASE(env), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary, description,
      start: { dateTime: startIso, timeZone: 'Asia/Taipei' },
      end: { dateTime: endIso, timeZone: 'Asia/Taipei' },
    }),
  });
  if (!res.ok) throw httpErr(502, 'calendar create: ' + (await res.text()).slice(0, 200));
  return (await res.json()).id;
}

async function calPatch(env, eventId, patch) {
  if (!env.GOOGLE_CALENDAR_ID) return;
  const token = await googleToken(env);
  const body = {};
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) body[k] = v;
  const res = await fetch(`${CAL_BASE(env)}/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpErr(502, 'calendar patch: ' + (await res.text()).slice(0, 200));
}

async function calDelete(env, eventId) {
  if (!env.GOOGLE_CALENDAR_ID) return;
  const token = await googleToken(env);
  const res = await fetch(`${CAL_BASE(env)}/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404＝事件已不存在，視為成功
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw httpErr(502, 'calendar delete: ' + (await res.text()).slice(0, 200));
  }
}

// 讀某本日曆在時間範圍內的事件（singleEvents 展開週期性事件、依開始時間排序）
async function calList(env, calendarId, timeMin, timeMax) {
  if (!calendarId) return [];
  const token = await googleToken(env);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?singleEvents=true&orderBy=startTime&maxResults=2500`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw httpErr(502, 'calendar list: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.items || []).map(ev => ({
    title: ev.summary || '',
    start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
    end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
    allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
  }));
}

// ── Google 服務帳號 → OAuth2 access token（RS256 JWT，WebCrypto） ──
let _tokenCache = { token: null, exp: 0 };
async function googleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp > now + 60) return _tokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/calendar',
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
function twDateTimeStr(d) {
  const tw = new Date(d.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}/${p(tw.getUTCMonth() + 1)}/${p(tw.getUTCDate())}（${'日一二三四五六'[tw.getUTCDay()]}）${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}`;
}
function twSlotIso(dateStr, hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return '';
  return new Date(`${dateStr}T${hhmm}:00+08:00`).toISOString();
}
// 某預約日「前一日 21:00（台灣）」的時間點 ＝ 當日 00:00 往前 3 小時。
// 用途：預約截止（每天21:00關隔日）與取消截止共用同一條線。
function dayBefore21Ms(startIso) {
  const dateStr = twDateStr(new Date(startIso));                       // 預約當天(台灣)
  const midnight = new Date(dateStr + 'T00:00:00+08:00').getTime();     // 當天 00:00
  return midnight - 3 * 3600000;                                        // 前一日 21:00
}
// 線上預約是否已截止：今天的時段永遠開放（到時段時間）；未來的時段一過
// 「前一日 21:00」就關閉。回 true＝已截止、不可線上預約。
function bookingClosed(startIso) {
  const dateStr = twDateStr(new Date(startIso));
  const todayStr = twDateStr(new Date());
  if (dateStr === todayStr) return false;
  return Date.now() >= dayBefore21Ms(startIso);
}
// 由出生年月日(yyyy-mm-dd)換算年齡；無法解析回空字串。
function ageFromBirthday(bd) {
  const s = String(bd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const now = new Date(Date.now() + 8 * 3600000);
  let age = now.getUTCFullYear() - parseInt(m[1], 10);
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < parseInt(m[2], 10) * 100 + parseInt(m[3], 10)) age--;
  return age >= 0 && age < 130 ? String(age) : '';
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

// ── 行事曆 .ics（GET /ics?start=&end=&title=&loc=）──
// 純用網址參數產生，不查 Firestore、不含客人姓名（隱私安全）。
function icsResponse(params) {
  const ds = icsDate(params.get('start'));
  const de = icsDate(params.get('end'));
  if (!ds || !de) return new Response('bad params', { status: 400 });
  const title = (params.get('title') || '經絡調理預約').slice(0, 100);
  const loc = (params.get('loc') || '').slice(0, 200);
  const esc = s => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//relax-clinic//booking//TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:relax-' + ds + '@relax-clinic',
    'DTSTAMP:' + icsDate(new Date().toISOString()),
    'DTSTART:' + ds,
    'DTEND:' + de,
    'SUMMARY:' + esc(title),
    loc ? 'LOCATION:' + esc(loc) : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="booking.ics"',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
// ISO 時間 → ICS 的 UTC 基本格式 YYYYMMDDTHHMMSSZ
function icsDate(iso) {
  const d = new Date(iso || '');
  if (isNaN(d)) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function normPhone(s) { return String(s || '').replace(/[^0-9]/g, ''); }
