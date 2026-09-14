const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ===== 时间轴定义，必须与 miniprogram/utils/status.js 保持一致 =====
const DAY_START_MINUTES = 8 * 60 + 30; // 8:30
const DAY_END_MINUTES = 18 * 60; // 18:00
const STEP_MINUTES = 30;
const SLOT_COUNT = (DAY_END_MINUTES - DAY_START_MINUTES) / STEP_MINUTES; // 19

const VALID_TYPES = ['office', 'meeting', 'trip', 'leave'];

// 单条记录的起止跨度上限（按日期差算）。出差最长按 30 天计。
const SPAN_LIMIT_DAYS = 30;

// 云数据库单次 get 上限 100 条，超出会静默截断，必须分页循环取。
const PAGE_SIZE = 100;
const PAGE_GUARD = 30; // 最多翻 30 页（3000 条），防御性上限

// ===== 集合自动初始化 =====
// 云开发不会为云函数自动建集合，漏建会报 "database collection not exists"。
const REQUIRED_COLLECTIONS = ['staff', 'presence'];
let collectionsReady = null;

function ensureCollections() {
  if (!collectionsReady) {
    collectionsReady = (async () => {
      for (const name of REQUIRED_COLLECTIONS) {
        try {
          await db.collection(name).limit(1).get();
        } catch (e) {
          try {
            await db.createCollection(name);
          } catch (e2) {
            // 并发调用时另一个实例可能已建好，忽略
          }
        }
      }
      return true;
    })().catch(() => {
      collectionsReady = null;
      return false;
    });
  }
  return collectionsReady;
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function minutesToText(min) {
  return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
}

function slotStartText(i) {
  return minutesToText(DAY_START_MINUTES + i * STEP_MINUTES);
}

function slotEndText(i) {
  return minutesToText(DAY_START_MINUTES + (i + 1) * STEP_MINUTES);
}

function timeTextToMinutes(text) {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

// 云函数运行在 UTC 时区。凡是把「北京时间的某天某时刻」转成 Date，
// 必须显式带上 +08:00，否则整体会偏移 8 小时——
// 比如「8:30 上班」会被算成北京时间 16:30，时间轴全错。
function beijingTime(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00+08:00');
}

function dayStart(dateStr) {
  return new Date(dateStr + 'T00:00:00+08:00');
}

function dayEnd(dateStr) {
  return new Date(dateStr + 'T23:59:59+08:00');
}

// 云函数的本地时区是 UTC，直接调 getHours() 会拿到 UTC 小时。
// 要取「北京时间」，先把时间戳整体 +8 小时再用 UTC 系列 getter 读，
// 这样无论运行环境时区如何，结果都稳定。
function beijingParts(d) {
  const t = new Date(d).getTime() + 8 * 60 * 60 * 1000;
  const bj = new Date(t);
  return {
    year: bj.getUTCFullYear(),
    month: bj.getUTCMonth() + 1,
    day: bj.getUTCDate(),
    hour: bj.getUTCHours(),
    minute: bj.getUTCMinutes(),
  };
}

function toMinuteText(d) {
  const p = beijingParts(d);
  return pad(p.hour) + ':' + pad(p.minute);
}

function toDateText(d) {
  const p = beijingParts(d);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}

// '9/14' 这种短格式，用在跨天记录的时间描述里
function toShortDate(d) {
  const p = beijingParts(d);
  return p.month + '/' + p.day;
}

// 分页拉全量，避免 100 条上限静默截断
async function fetchAll(collection, where, orderField) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < PAGE_GUARD; i++) {
    let q = db.collection(collection).where(where);
    if (orderField) q = q.orderBy(orderField, 'asc');
    const res = await q.skip(skip).limit(PAGE_SIZE).get();
    out.push(...res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return out;
}

// 把当天的记录摊平成 19 个格子，空格子为 ''
function buildDots(records, dateStr) {
  const dots = [];
  for (let i = 0; i < SLOT_COUNT; i++) dots.push('');

  const base = dayStart(dateStr).getTime();

  records.forEach((r) => {
    const s = new Date(r.startAt).getTime();
    const e = new Date(r.endAt).getTime();
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotStart = base + (DAY_START_MINUTES + i * STEP_MINUTES) * 60000;
      const slotEnd = slotStart + STEP_MINUTES * 60000;
      // 只要该格子与记录区间有交集就算覆盖
      if (s < slotEnd && e > slotStart) dots[i] = r.type;
    }
  });

  return dots;
}

// 把 19 个格子合并成连续区间，供界面显示「开会 10:30-12:00」这样的文本
function mergeSegments(dots) {
  const segs = [];
  let cur = null;
  for (let i = 0; i < dots.length; i++) {
    const t = dots[i];
    if (!t) {
      cur = null;
      continue;
    }
    if (cur && cur.type === t && cur.endIndex === i - 1) {
      cur.endIndex = i;
    } else {
      cur = { type: t, startIndex: i, endIndex: i };
      segs.push(cur);
    }
  }
  return segs.map((s) => ({
    type: s.type,
    span: s.endIndex - s.startIndex + 1,
    start: slotStartText(s.startIndex),
    end: slotEndText(s.endIndex),
    text: slotStartText(s.startIndex) + '-' + slotEndText(s.endIndex),
  }));
}

// 给一个时间段找它对应的记录备注（出差地 / 请假事由）。
//
// 为什么要「类型 + 时间重叠」双重匹配：同一个人一天里可能有多条记录
// （上午京内出差、下午请假），只按类型找会把不相干的备注贴到这一段上。
// 另外跨天的长记录会被按天切成多段，每段都能匹配回同一条记录，
// 所以出差第二天仍然带着同一个出差地。
function noteForSegment(mine, dateStr, seg) {
  if (!mine || !mine.length || !seg) return '';
  const base = dayStart(dateStr).getTime();
  const sMin = base + timeTextToMinutes(seg.start) * 60000;
  const eMin = base + timeTextToMinutes(seg.end) * 60000;
  const rec = mine.find((r) => {
    if (r.type !== seg.type) return false;
    const rStart = new Date(r.startAt).getTime();
    const rEnd = new Date(r.endAt).getTime();
    return rStart < eMin && rEnd > sMin;
  });
  return rec ? (rec.note || '') : '';
}

// 取时段最多的那个状态作为「主要状态」，用于列表标签和人数统计
function mainTypeOf(dots, fallback) {
  const count = {};
  dots.forEach((t) => {
    if (t) count[t] = (count[t] || 0) + 1;
  });
  let best = fallback || '';
  let max = 0;
  Object.keys(count).forEach((k) => {
    if (count[k] > max) {
      max = count[k];
      best = k;
    }
  });
  return best;
}

exports.main = async (event) => {
  await ensureCollections();

  const { OPENID } = cloud.getWXContext();
  const action = event && event.action;

  switch (action) {
    case 'day':
      return dayBoard(event);
    case 'range':
      return rangeBoard(event);
    case 'save':
      return saveRecords(event, OPENID);
    case 'remove':
      return removeRecord(event, OPENID);
    case 'mine':
      return myRecords(OPENID);
    default:
      return { success: false, message: '未知操作' };
  }
};

// 取某科室（dept 为空则全部）的人员与当天记录，算出每人 19 格状态
async function collectDay(dept, dateStr) {
  const staffWhere = { active: _.neq(false) };
  if (dept) staffWhere.dept = dept;
  const staffList = await fetchAll('staff', staffWhere);

  const recWhere = {
    startAt: _.lt(dayEnd(dateStr)),
    endAt: _.gt(dayStart(dateStr)),
  };
  if (dept) recWhere.dept = dept;
  const records = await fetchAll('presence', recWhere);

  const byOwner = {};
  records.forEach((r) => {
    if (!r._openid) return;
    if (!byOwner[r._openid]) byOwner[r._openid] = [];
    byOwner[r._openid].push(r);
  });

  const people = staffList.map((s) => {
    const joined = !!s.openid;
    // 按开始时间升序排列，保证「第一个非 office 记录」与「第一个非 office 时段」对应，
    // 这样看板标签上显示的备注（出差地 / 请假事由）才和该时段匹配。
    const mine = (joined && byOwner[s.openid]) ? byOwner[s.openid].slice().sort((a, b) => new Date(a.startAt) - new Date(b.startAt)) : [];
    const hasRecord = mine.length > 0;
    let dots;
    let confirmed;
    if (hasRecord) {
      dots = buildDots(mine, dateStr);
      confirmed = true;
    } else {
      // 没有任何记录 → 默认按在岗显示。
      // 跨天的出差/请假会被上面的区间查询自然捞出来（记录区间与当天有交集），
      // 所以这里不需要单独判断「延续昨天」，也不会出现出差第二天变在岗的问题。
      dots = [];
      for (let i = 0; i < SLOT_COUNT; i++) dots.push(joined ? 'office' : '');
      confirmed = false;
    }

    const segments = mergeSegments(dots);
    const mainType = mainTypeOf(dots, joined ? 'office' : '');
    const firstNonOffice = segments.find((x) => x.type !== 'office');

    // 看板标签要显示「出差地/请假事由」时，取与第一个非 office 时段对应的记录备注
    const tagNote = firstNonOffice ? noteForSegment(mine, dateStr, firstNonOffice) : '';

    return {
      openid: s.openid || '',
      name: s.name || '',
      dept: s.dept || '',
      // 电话由本人认领时填、存在 staff 记录上；看板点姓名要拨号，所以带出来。
      // 未认领的人没有电话，前端据此提示「还没有认领身份」。
      phone: s.phone || '',
      joined,
      confirmed,
      dots,
      segments,
      mainType,
      // 列表右侧标签：有外出安排就优先显示外出安排
      tagType: firstNonOffice ? firstNonOffice.type : mainType,
      tagText: firstNonOffice ? firstNonOffice.text : segments.length ? segments[0].text : '',
      tagNote,
      note: mine.length ? mine[0].note || '' : '',
      recordCount: mine.length,
    };
  });

  // 统计口径：以每人当天的主导状态计一次。
  // 未填/未确认的人按在岗（office）计入，与看板显示口径一致。
  const stats = {
    total: people.length,
    office: 0,
    meeting: 0,
    trip: 0,
    leave: 0,
    unjoined: 0,
  };
  people.forEach((p) => {
    if (!p.joined) {
      stats.unjoined++;
      return;
    }
    if (stats[p.mainType] !== undefined) stats[p.mainType]++;
  });

  return { people, stats };
}

async function dayBoard(event) {
  const dateStr = event.date;
  if (!dateStr) return { success: false, message: '缺少日期' };
  const dept = event.dept || '';

  const { people, stats } = await collectDay(dept, dateStr);

  return {
    success: true,
    date: dateStr,
    dept,
    slotCount: SLOT_COUNT,
    slotStarts: (() => {
      const a = [];
      for (let i = 0; i < SLOT_COUNT; i++) a.push(slotStartText(i));
      return a;
    })(),
    people,
    stats,
  };
}

// 第二屏：最近若干个工作日的分布。
// 每天合并成若干色块，色块宽度 = 该状态持续的时间占比。
async function rangeBoard(event) {
  const dates = (event.dates || []).filter((d) => !!d);
  if (dates.length === 0) return { success: false, message: '缺少日期' };
  const dept = event.dept || '';
  const sorted = dates.slice().sort();

  const staffWhere = { active: _.neq(false) };
  if (dept) staffWhere.dept = dept;
  const staffList = await fetchAll('staff', staffWhere);

  // 一次把整个区间的记录拉出来，再在内存里按天拆分，避免逐天查库
  const recWhere = {
    startAt: _.lt(dayEnd(sorted[sorted.length - 1])),
    endAt: _.gt(dayStart(sorted[0])),
  };
  if (dept) recWhere.dept = dept;
  const records = await fetchAll('presence', recWhere);

  const byOwner = {};
  records.forEach((r) => {
    if (!r._openid) return;
    if (!byOwner[r._openid]) byOwner[r._openid] = [];
    byOwner[r._openid].push(r);
  });

  const people = staffList.map((s) => {
    const joined = !!s.openid;
    const mine = (joined && byOwner[s.openid]) || [];

    const days = dates.map((d) => {
      const hasRecord = mine.some((r) => {
        return new Date(r.startAt).getTime() < dayEnd(d).getTime() && new Date(r.endAt).getTime() > dayStart(d).getTime();
      });
      const dots = hasRecord ? buildDots(mine, d) : [];
      if (!hasRecord) {
        for (let i = 0; i < SLOT_COUNT; i++) dots.push(joined ? 'office' : '');
      }
      const segments = mergeSegments(dots);
      const mainType = mainTypeOf(dots, joined ? 'office' : '');
      // 第二屏色条下方要列当天所有「不在岗」时段（备注 + 时间段）。
      // 在岗不列：色条本身已经表达清楚了，列进去只会把每行撑高一倍。
      // 备注为空的老记录（备注是后加的必填项）由前端退化成状态名，这里原样传空串。
      const items = segments
        .filter((sg) => sg.type !== 'office')
        .map((sg) => ({
          type: sg.type,
          time: sg.text,
          note: noteForSegment(mine, d, sg),
        }));
      return {
        date: d,
        confirmed: hasRecord,
        joined,
        segments,
        mainType,
        items,
        // 供 WXML 直接渲染：色块宽度用 span，样式类用 dotClass
        empty: !joined,
      };
    });

    return {
      openid: s.openid || '',
      name: s.name || '',
      dept: s.dept || '',
      phone: s.phone || '',
      joined,
      days,
    };
  });

  return { success: true, dates, dept, people };
}

// 校验并保存一段去向。
// 两种形态：
//   同日 —— startDate === endDate，配合 startTime/endTime（如 10:30-12:00 在办公室）
//   跨天 —— startDate !== endDate，出差/请假按整天记（8:30-18:00）
// 同一天内与该时段重叠的旧记录会被裁剪或删除。
async function saveRecords(event, openid) {
  const { type, startTime, endTime, note } = event;
  const startDate = event.startDate || event.date;
  const endDate = event.endDate || event.date || startDate;

  if (!startDate) return { success: false, message: '缺少日期' };
  if (VALID_TYPES.indexOf(type) < 0) return { success: false, message: '请选择去向状态' };
  if (!startTime || !endTime) return { success: false, message: '请选择时间段' };
  if (endDate < startDate) return { success: false, message: '结束日期不能早于开始日期' };

  // 备注必填：出差填「出差地」、请假填「请假事由」。
  // 前端已拦过一次，这里再拦是为了防止旧版本客户端或直接调接口漏过去。
  const noteText = (note || '').trim();
  if (!noteText) {
    return {
      success: false,
      message: type === 'leave' ? '请填写请假事由' : '请填写出差地',
    };
  }

  // 跨度上限：防止把日期选成下个月之类的手滑
  const spanDays = Math.round(
    (dayStart(endDate).getTime() - dayStart(startDate).getTime()) / 86400000
  );
  if (spanDays > SPAN_LIMIT_DAYS) {
    return { success: false, message: '时间跨度不能超过 ' + SPAN_LIMIT_DAYS + ' 天' };
  }

  const newStart = beijingTime(startDate, startTime).getTime();
  const newEnd = beijingTime(endDate, endTime).getTime();
  if (!(newEnd > newStart)) return { success: false, message: '结束时间需晚于开始时间' };

  // 必须已认领身份，否则记录无法归属到人
  const staffRes = await db.collection('staff').where({ openid }).limit(1).get();
  if (staffRes.data.length === 0) {
    return { success: false, message: '请先在「我的」里认领身份' };
  }
  const me = staffRes.data[0];

  // 取出与「新记录所在区间」相交的我的所有记录，逐条处理重叠
  const existRes = await db.collection('presence')
    .where({
      _openid: openid,
      startAt: _.lt(dayEnd(endDate)),
      endAt: _.gt(dayStart(startDate)),
    })
    .limit(PAGE_SIZE)
    .get();

  for (const old of existRes.data) {
    const os = new Date(old.startAt).getTime();
    const oe = new Date(old.endAt).getTime();
    if (os >= newEnd || oe <= newStart) continue; // 不相交

    if (os >= newStart && oe <= newEnd) {
      // 完全被新记录覆盖 → 删除
      await db.collection('presence').doc(old._id).remove();
    } else if (os < newStart && oe > newEnd) {
      // 新记录落在旧记录中间 → 旧记录被切成左右两段
      await db.collection('presence').doc(old._id).update({
        data: { endAt: new Date(newStart), updatedAt: db.serverDate() },
      });
      await db.collection('presence').add({
        data: {
          _openid: openid,
          name: old.name,
          dept: old.dept,
          type: old.type,
          startAt: new Date(newEnd),
          endAt: new Date(oe),
          note: old.note || '',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
    } else if (os < newStart) {
      // 尾部重叠 → 截断
      await db.collection('presence').doc(old._id).update({
        data: { endAt: new Date(newStart), updatedAt: db.serverDate() },
      });
    } else {
      // 头部重叠 → 前移
      await db.collection('presence').doc(old._id).update({
        data: { startAt: new Date(newEnd), updatedAt: db.serverDate() },
      });
    }
  }

  await db.collection('presence').add({
    data: {
      _openid: openid,
      name: me.name || '',
      dept: me.dept || '',
      type,
      startAt: new Date(newStart),
      endAt: new Date(newEnd),
      note: noteText.slice(0, 50),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });

  // 顺带回传最新的「我的记录」，前端直接用，省掉一次云函数调用
  return { success: true, list: await fetchMyRecords(openid) };
}

async function removeRecord(event, openid) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少记录 ID' };
  let doc;
  try {
    doc = await db.collection('presence').doc(id).get();
  } catch (e) {
    return { success: false, message: '记录不存在' };
  }
  if (!doc.data || doc.data._openid !== openid) {
    return { success: false, message: '只能删除自己的记录' };
  }
  await db.collection('presence').doc(id).remove();
  return { success: true, list: await fetchMyRecords(openid) };
}

// 我的近期记录，按时间倒序（含未来已填的）
// 把「我的记录」整形为前端渲染结构。
// save / remove / mine 三个入口共用，这样写操作可以顺带回传最新列表，
// 前端就不必再发一次云函数调用来刷新（一次冷启动能省 1~3 秒）。
function shapeMyRecords(rows) {
  return rows.map((r) => {
    const s = new Date(r.startAt);
    const e = new Date(r.endAt);
    const startDate = toDateText(s);
    const endDate = toDateText(e);
    const sameDay = startDate === endDate;
    return {
      _id: r._id,
      type: r.type,
      note: r.note || '',
      date: startDate,
      sameDay,
      // 同一天内才显示「09:00-18:00」这种时刻区间；
      // 跨天时时刻已经写进 dateText，这里留空由前端隐藏，避免看起来像同一天。
      rangeText: sameDay ? toMinuteText(s) + '-' + toMinuteText(e) : '',
      dateText: sameDay
        ? startDate
        : toShortDate(s) + ' ' + toMinuteText(s) + ' 至 ' + toShortDate(e) + ' ' + toMinuteText(e),
    };
  });
}

async function fetchMyRecords(openid) {
  const res = await db.collection('presence')
    .where({ _openid: openid })
    .orderBy('startAt', 'desc')
    .limit(50)
    .get();
  return shapeMyRecords(res.data);
}

async function myRecords(openid) {
  return { success: true, list: await fetchMyRecords(openid) };
}
