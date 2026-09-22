const cloud = require('wx-server-sdk');
// 内置模块，用来压 xlsx 的 zip 容器（见文件末尾「手写 xlsx」一节）。
const zlib = require('zlib');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ===== 时间轴定义，必须与 miniprogram/utils/status.js 保持一致 =====
const DAY_START_MINUTES = 8 * 60 + 30; // 8:30
const DAY_END_MINUTES = 18 * 60; // 18:00
const STEP_MINUTES = 30;
const SLOT_COUNT = (DAY_END_MINUTES - DAY_START_MINUTES) / STEP_MINUTES; // 19

const VALID_TYPES = ['office', 'meeting', 'trip', 'leave'];

// 请假事由的固定取值域，必须与 miniprogram/utils/note.js 的 LEAVE_REASONS 保持一致
// （小程序端不给输入框，事由只能从这 7 项里点选；服务端在这里再卡一次，
// 防止旧版本客户端或直接调接口写进「年假 / 公休」这类同义不同字）。
const LEAVE_REASONS = ['事假', '病假', '年休假', '探亲假', '婚假', '产假', '丧假'];

// 单条记录的起止跨度上限（按日期差算）。出差最长按 30 天计。
const SPAN_LIMIT_DAYS = 30;

// 状态中文名，用于「与 xx 的『京内出差』有交叉」这类提示。
// 必须与 miniprogram/utils/status.js 的 TYPES.label 一致。
const TYPE_TEXT = { office: '在岗', meeting: '京内出差', trip: '京外出差', leave: '请假' };

// 已经开始、还没结束的记录，只有「距开始不到 5 小时」才允许整条删除。
// 区别在于：删除会把**已经发生的那部分也一起抹掉**，终止只保留已发生的部分、
// 把结束时间收回来。给刚填错的人留一个 5 小时的纠正窗口，之后就必须走「提前终止」。
const DELETE_WINDOW_HOURS = 5;
const HOUR_MS = 60 * 60 * 1000;

// 终止记录时把结束时间对齐到「当前所在半天的开始点」：
//   08:30–12:00 之间 → 回到今天 08:30（今天上午这半天不算）
//   12:00–18:00 之间 → 回到今天 12:00（今天下午这半天不算）
//   早于 08:30       → 今天 08:30（同第一行）
//   晚于 18:00       → 今天 18:00（当天已经过完，终止不影响当天）
// 对齐到半天边界而不是「此刻」，是为了和考勤的半天粒度（上午 08:30-12:00 /
// 下午 12:00-18:00 各 0.5 天）保持一致，不会留下 09:17 这种不规则边界。
const HALF_START_MORNING = '08:30';
const HALF_START_AFTERNOON = '12:00';
const DAY_END_TEXT = '18:00';

// 云数据库单次 get 上限 100 条，超出会静默截断，必须分页循环取。
const PAGE_SIZE = 100;
const PAGE_GUARD = 30; // 最多翻 30 页（3000 条），防御性上限

// ===== 集合自动初始化 =====
// 云开发不会为云函数自动建集合，漏建会报 "database collection not exists"。
// presence_logs 存的是「谁在什么时候删/改/终止了哪条记录」，
// 是防篡改规则的最后一道兜底——它能自动建起来这件事很重要，别手删。
const REQUIRED_COLLECTIONS = ['staff', 'presence', 'presence_logs'];
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

// 北京时间的「今天」日期字符串（YYYY-MM-DD）。
// 云函数跑在 UTC，这里不能直接拿 getDate()——北京时间 0:00~8:00 那一段，
// UTC 还停在前一天，「开始日期不能早于今天」的校验会错放行 8 小时。
function todayText(now) {
  return toDateText(now || new Date());
}

// 记录相对「此刻」的状态：
//   future 还没开始 —— 可自由删除
//   active 进行中   —— 可终止；删除另有 5 小时窗口
//   ended  已结束   —— 只读，界面置灰
function recordState(rec, nowTs) {
  const s = new Date(rec.startAt).getTime();
  const e = new Date(rec.endAt).getTime();
  if (nowTs < s) return 'future';
  if (nowTs < e) return 'active';
  return 'ended';
}

// 删除受阻的原因，空串表示可删。
// 前端据此把按钮置灰并说明原因——只回一个 true/false 的话，
// 用户点了没反应会以为是卡住了。
function deleteBlockReason(rec, nowTs) {
  const state = recordState(rec, nowTs);
  if (state === 'ended') return 'ended';
  if (state === 'future') return '';
  // 进行中：只看「距开始是否不到 5 小时」，与是哪一天无关
  return nowTs - new Date(rec.startAt).getTime() < DELETE_WINDOW_HOURS * HOUR_MS
    ? ''
    : 'window';
}

// 「当前所在半天的开始点」的时间戳，终止记录时作为新的结束时间。
function halfStartOfNow(now) {
  const d = now || new Date();
  const today = toDateText(d);
  const p = beijingParts(d);
  const minutes = p.hour * 60 + p.minute;
  if (minutes >= DAY_END_MINUTES) return beijingTime(today, DAY_END_TEXT).getTime();
  if (minutes >= 12 * 60) return beijingTime(today, HALF_START_AFTERNOON).getTime();
  return beijingTime(today, HALF_START_MORNING).getTime();
}

// 两个时间区间是否相交。**相邻不算相交**：上午 08:30-12:00 与下午 12:00-18:00
// 必须能无缝拼上，这是半天粒度的前提，所以两边都用严格不等号。
// 抽成独立函数是为了能单测——这段判定错了会直接放行「覆盖别人的请假」。
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// 一条记录的时间描述，用在交叉提示里：'9/22 08:30-12:00'（跨天两端都带日期）。
function recordRangeText(rec) {
  const s = new Date(rec.startAt);
  const e = new Date(rec.endAt);
  if (toDateText(s) === toDateText(e)) {
    return toShortDate(s) + ' ' + toMinuteText(s) + '-' + toMinuteText(e);
  }
  return toShortDate(s) + ' ' + toMinuteText(s) + ' 至 ' + toShortDate(e) + ' ' + toMinuteText(e);
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
    case 'stop':
      return stopRecord(event, OPENID);
    case 'mine':
      return myRecords(OPENID);
    case 'adminRecords':
      return adminRecords(event, OPENID);
    case 'adminSave':
      return adminSave(event, OPENID);
    case 'adminRemove':
      return adminRemove(event, OPENID);
    case 'export':
      return exportAttendance(event, OPENID);
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

// 「一个月」这类长区间视图用：算出每个日期上该人员的主导「不在岗」类型，无则 ''。
// 多条记录压在同一天时取开始最早的那条——所以函数内部自己排序，
// 不依赖调用方保证 mine 的顺序（rangeBoard 里的 mine 是数据库返回顺序）。
// 独立成函数是为了让测试脚本能把它抽出来单独跑（与 noteForSegment 同一思路）。
function computeMarks(mine, dates) {
  const sorted = mine.slice().sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return dates.map((d) => {
    const ds = dayStart(d).getTime();
    const de = dayEnd(d).getTime();
    const hit = sorted.find((r) => {
      if (r.type === 'office') return false;
      const rs = new Date(r.startAt).getTime();
      const re = new Date(r.endAt).getTime();
      return rs < de && re > ds;
    });
    return hit ? hit.type : '';
  });
}

// ===== 考勤表（导出用）=====

// 一天的工作时段，用来算「请假占了多久」。
//   上午 08:30-12:00（3.5 小时）+ 下午 12:00-18:00（6 小时）= 9.5 小时
// ⚠️ 这两个格子用来取「落在工作时段内的交集」，不再代表「半天 = 0.5 天」。
const HALVES = [
  { start: DAY_START_MINUTES, end: 12 * 60 },
  { start: 12 * 60, end: DAY_END_MINUTES },
];

// 每天的工作分钟数（= 570 分钟 = 9.5 小时），折算的除数。
// 从 HALVES 累加出来而不是写死 570，改了时段定义不用两处对账。
const WORK_MINUTES_PER_DAY = HALVES.reduce((a, h) => a + (h.end - h.start), 0);

// ===== 折算口径（2026-09-22 最终版，用户逐条确认）=====
//
//   ① 假期时长 X = 该类假落在工作时段内的时长（分钟）
//   ② 整天数 = ⌊X ÷ 9.5h⌋，余数 A = X − 整天数 × 9.5h
//   ③ 余数 A 分档： A ≤ 3h → 0 天
//                  3h < A ≤ 6h → 0.5 天
//                  6h < A → 1 天        （A 恒 < 9.5h）
//   ④ 该类假天数 = 整天数 + 档值
//   ⑤ 出勤 = Y − Σ各类假（Y = 该月工作日数）
//
// 为什么是「余数」而不是「X ÷ 9.5 后整体分档」：
//   若拿商去分档，档函数封顶只有 1 天，请 2 个整天（19h）会只算出 1 天、
//   整月全请也只会算出 1 天，出勤变成负数。所以整天必须先按 1 天/天拿走。
//
// ⚠️ 分档必然带来跳变（制度规定最小单位是 0.5 天，这是制度的定义而非缺陷）：
//   - 请 3h = 0 天，但请 3h05m = 0.5 天；
//   - 请 6h = 0.5 天，但请 6h05m = 1 天。
//   边界取整后不会失真：上午半天 3.5h → 0.5 天、下午半天 6h → 0.5 天（上下午等值）、
//   整天 9.5h → 1.00 天。**「整天 = 1.00 天」是锚点**，测试专门守着。
//
// 单位是「分钟」而不是「小时」：小时是浮点数，3h05m 写成 3.0833… 再比较会踩
// 浮点误差（3.0833 > 3 与 185 > 180 一个能保证、一个不能）。
const TIER_ZERO_MINUTES = 3 * 60; // ≤ 3h → 0 天
const TIER_HALF_MINUTES = 6 * 60; // ≤ 6h → 0.5 天，超过 → 1 天

// 把「落在工作时段内的分钟数」按上面的口径折成 0 / 0.5 / 1 / 1.5 … 天。
function minutesToDays(minutes) {
  if (!(minutes > 0)) return 0;
  const whole = Math.floor(minutes / WORK_MINUTES_PER_DAY); // 整天数
  const rest = minutes - whole * WORK_MINUTES_PER_DAY; // 余数（分钟）
  if (rest <= TIER_ZERO_MINUTES) return whole;
  if (rest <= TIER_HALF_MINUTES) return whole + 0.5;
  return whole + 1;
}

// 导出表的假期列顺序（用户指定：出勤在前，其后假期按这个顺序）。
// ⚠️ 顺序与 LEAVE_REASONS 不同（那份按使用频率排、事假病假在前），
// 所以不能直接拿 LEAVE_REASONS 当表头。两者必须是同一集合，
// %TEMP%/presence-attendance-test.js 有一条断言专门比对，改一处必须改另一处。
const LEAVE_COLS = ['年休假', '探亲假', '婚假', '产假', '丧假', '事假', '病假'];

// 折算出来的天数保留到 0.05 的刻度（用户指定），且不足 0.1 天记 0。
// 为什么要有刻度：570 分钟 ÷ 9.5 小时 → 3.5 小时 = 0.3684…，直接写进 xlsx
// 就是 0.3684210526315789，表格没法看。0.05 ≈ 28.5 分钟，够细。
// 为什么 <0.1 归零：0.5 小时只有 0.0526 天，四舍五入后是 0.05，满表都是这种
// 零星数字很吵；用户口径是「不足 0.1 天记 0」。
// ⚠️ 2026-09-22 换成「余数分档」后，各假本来就只可能是 0.5 的倍数，
// 这个函数只剩两个用途：① 汇总时的浮点尾巴规整；② 出勤的兜底归零。
// 保留它是因为出勤走「减法倒推」，仍可能出现 0.05 级的尾部。
function roundDays(v) {
  const r = Math.round(v * 20) / 20;
  return r < 0.1 ? 0 : r;
}

// 某类假在该区间内落在工作时段里的**分钟数**。
// 只累计**落在工作时段内**的部分：夜间、午休外、周末与节假日都不算，
// 因为 dates 传进来的就是工作日，而每天只在 HALVES 两段里取交集。
//   - 一条记录跨多天时逐日逐段切，天然只算工作日那几天；
//   - 与某段有交集就算那一段的**实际时长**（不像旧算法「有交集就记整半天」）。
// note 为 null 时累计所有请假（不分类），classification 由调用方按列分别调用。
function leaveMinutes(mine, dates, note) {
  let minutes = 0;
  dates.forEach((d) => {
    const base = dayStart(d).getTime();
    HALVES.forEach((h) => {
      const hs = base + h.start * 60000;
      const he = base + h.end * 60000;
      mine.forEach((r) => {
        if (r.type !== 'leave') return;
        if (note != null && (r.note || '').trim() !== note) return;
        const rs = new Date(r.startAt).getTime();
        const re = new Date(r.endAt).getTime();
        const a = Math.max(rs, hs);
        const b = Math.min(re, he);
        if (b > a) minutes += (b - a) / 60000;
      });
    });
  });
  return minutes;
}

// 某类假折算出的天数 = 该假落在工作时段内的分钟数 → 余数分档（见 minutesToDays）。
function leaveDays(mine, dates, note) {
  return minutesToDays(leaveMinutes(mine, dates, note));
}

// 统计每人各类假的天数，返回可直接写进表格的行。
//
// 口径（2026-09-22 最终版，与用户逐条确认过，详见 minutesToDays 上方注释）：
//   - 假期时长 X = 各类假落在工作时段内的时长；
//   - 天数 = ⌊X ÷ 9.5h⌋（整天）+ 余数分档（≤3h 记 0 / 3~6h 记 0.5 / >6h 记 1）；
//   - 所以各列只可能是 0.5 的倍数，最小单位 0.5 天（与单位制度一致）；
//   - **出勤 = Y − X总，用减法倒推**（Y = 该月工作日数）——这样
//     「出勤 + 各类假 = Y」天然成立，不会因为两处独立累计而对不上账；
//   - 出差（京内/京外）与在岗一样直接算在出勤里，**不折算、不占假期额度**；
//   - 没有任何记录 = 默认在岗 = 出勤（与看板「默认在岗」一致）；
//   - 请假但事由不在 7 项白名单内（白名单上线前的老记录）不计入任何一类，
//     该时段落回默认在岗（用户口径：「老记录忽略不计」）；
//   - 未认领的人不出现（没有 openid 就没有归属）。
//
// 独立成纯函数是为了让测试能抽出来单独跑（与 computeMarks 同一思路）。
function buildAttendance(staffList, records, dates) {
  const byOwner = {};
  records.forEach((r) => {
    if (!r._openid) return;
    if (!byOwner[r._openid]) byOwner[r._openid] = [];
    byOwner[r._openid].push(r);
  });

  const rows = staffList
    .filter((s) => !!s.openid)
    .map((s) => {
      const mine = byOwner[s.openid] || [];
      const row = { jobNo: s.jobNo || '', name: s.name || '', dept: s.dept || '', office: 0 };
      let leaveTotal = 0;
      LEAVE_COLS.forEach((c) => {
        // 每类假各自分档——**分档是逐类做的，不是先加总再分档**。
        // 若先加总再分档，「上午事假 3.5h + 下午病假 6h」会合成 9.5h 算出 1 天，
        // 反而比两类各自 0.5 + 0.5 更多，账就串了。
        const days = leaveDays(mine, dates, c);
        row[c] = days;
        leaveTotal += days;
      });
      // 各列都是 0.5 的倍数，相加只可能带浮点尾巴（0.5 + 0.5 未必正好 1）。
      leaveTotal = Math.round(leaveTotal * 2) / 2;
      row.office = roundDays(dates.length - leaveTotal);
      row.total = dates.length;
      return row;
    });

  // 科室升序、科室内工号升序。名册的插入顺序没有业务含义，
  // 而考勤表要给人看/存档，稳定可预期的顺序比「导入顺序」重要。
  rows.sort((a, b) => {
    if (a.dept !== b.dept) return a.dept < b.dept ? -1 : 1;
    if (a.jobNo !== b.jobNo) return a.jobNo < b.jobNo ? -1 : 1;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });

  return rows;
}

async function checkAdmin(openid) {
  if (!openid) return false;
  const res = await db.collection('staff').where({ openid, isAdmin: true }).limit(1).get();
  return res.data.length > 0;
}

// 第二屏：最近若干个工作日的分布。
// 每天合并成若干色块，色块宽度 = 该状态持续的时间占比。
async function rangeBoard(event) {
  const dates = (event.dates || []).filter((d) => !!d);
  if (dates.length === 0) return { success: false, message: '缺少日期' };
  const dept = event.dept || '';
  // compact 模式给「一个月」这类长区间视图用：只回传每人每天的主导不在岗类型，
  // 不回传 19 格 segments——30 天 × 每天若干段的完整结构会把响应撑到几百 KB。
  const compact = !!event.compact;
  const sorted = dates.slice().sort();

  const staffWhere = { active: _.neq(false) };
  if (dept) staffWhere.dept = dept;
  const staffList = await fetchAll('staff', staffWhere);

  // 一次把整个区间的记录拉出来，再在内存里按天拆分，避免逐天查库。
  //
  // 注意：这里不能再用 startAt 上限（原先是「startAt < 窗口最后一天结束」）。
  // 弹窗要显示「今天及以后（含三天窗口之外）」的全部不在岗申请，
  // 若卡这个上限，周四~周六的出差根本查不出来——它的 startAt 晚于窗口最后一天，
  // 数据库直接把它过滤掉了，后面 applications 的过滤条件再宽松也拿不到数据。
  // 所以只保留 endAt 下界：结束时间晚于窗口第一天 0 点的记录全部拉回
  // （即「今天及以后仍未结束」的记录，包含跨天延续到今天的、以及未来任意一天的）。
  const recWhere = {
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

    // compact 模式不需要逐天的 19 格分段，直接跳过（省一半以上的计算与响应体积）
    const days = compact ? [] : dates.map((d) => {
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

    // 点色条弹窗用：列出「今天及以后（含三天之后）的所有不在岗申请」，每条显示完整起止区间
    // （而非按天切片的色块）。例如周一申请整周出差，周三点开仍显示这一整段出差；
    // 又如周一申请周四~周六出差，虽然落在三天窗口之外，也一并显示出来，方便提前掌握去向。
    // 口径：结束时间晚于今天 0 点的申请都算（即尚未结束的、以及未来任何一天的），不限提交时间。
    const winStart = dayStart(dates[0]).getTime();
    const applications = mine
      .filter((r) => {
        if (r.type === 'office') return false;
        const re = new Date(r.endAt).getTime();
        return re > winStart;
      })
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
      .map((r) => {
        const rs = new Date(r.startAt).getTime();
        const re = new Date(r.endAt).getTime();
        return {
          type: r.type,
          note: r.note || '',
          rangeLabel: toShortDate(r.startAt) + ' ' + toMinuteText(r.startAt) + ' - ' + toShortDate(r.endAt) + ' ' + toMinuteText(r.endAt),
          // 覆盖这三天中的哪几天：弹窗里用来高亮被点的那天（若这条申请落在那天）
          coverDays: dates.map((d) => {
            const ds = dayStart(d).getTime();
            const de = dayEnd(d).getTime();
            return rs < de && re > ds;
          }),
        };
      });

    // 「一个月」长区间视图：轻量结构，每人只带 30 个格子的主导不在岗类型 + 申请列表
    if (compact) {
      return {
        openid: s.openid || '',
        name: s.name || '',
        dept: s.dept || '',
        phone: s.phone || '',
        joined,
        marks: computeMarks(mine, dates),
        applications,
      };
    }

    return {
      openid: s.openid || '',
      name: s.name || '',
      dept: s.dept || '',
      phone: s.phone || '',
      joined,
      days,
      applications,
    };
  });

  return { success: true, dates, dept, people };
}

// 校验并保存一段去向。
// 两种形态：
//   同日 —— startDate === endDate，配合 startTime/endTime（如 10:30-12:00 在办公室）
//   跨天 —— startDate !== endDate，出差/请假按整天记（8:30-18:00）
//
// ⚠️ 与已有记录相交时**直接拒绝**，不再静默裁剪/覆盖。
// 以前是「把旧记录删掉 / 截断 / 切成两段」，等于员工只要重填一条就能抹掉
// 自己已经填过的请假——导出的考勤表因此不可信。现在改成明确报错并指出是与哪一条冲突。
//
// opts（只有管理员代填/代改时才传，普通员工路径不传）：
//   allowPast   —— 豁免「开始日期不能早于今天」
//   force       —— 相交时强制覆盖（删/裁剪旧记录），而不是拒绝
//   ownerOpenid —— 记录归属人（管理员代员工填，记录挂在员工名下）
//   actorOpenid —— 操作人（写日志用；普通员工即本人）
async function saveRecords(event, openid, opts) {
  const opt = opts || {};
  const owner = opt.ownerOpenid || openid;
  const { type, startTime, endTime, note } = event;
  const startDate = event.startDate || event.date;
  const endDate = event.endDate || event.date || startDate;

  if (!startDate) return { success: false, message: '缺少日期' };
  if (VALID_TYPES.indexOf(type) < 0) return { success: false, message: '请选择去向状态' };
  if (!startTime || !endTime) return { success: false, message: '请选择时间段' };
  if (endDate < startDate) return { success: false, message: '结束日期不能早于开始日期' };

  // 只能从今天开始填，不允许补填昨天及更早。
  // 前端 picker 的 dateMin 只拦得住界面——旧版本客户端、或直接调接口都能绕过，
  // 所以服务端必须再卡一次（管理员代填走 allowPast 豁免，否则漏记就真的无解）。
  // ⚠️ 比较基准要用北京时间的今天（todayText），云函数本地是 UTC，
  // 北京时间 0:00~8:00 那段直接取日期会拿到昨天。
  if (!opt.allowPast && startDate < todayText()) {
    return { success: false, message: '开始日期不能早于今天；补填历史记录请联系管理员' };
  }

  // 备注必填：出差填「出差地」、请假选「请假事由」。
  // 前端已拦过一次，这里再拦是为了防止旧版本客户端或直接调接口漏过去。
  const noteText = (note || '').trim();
  if (!noteText) {
    return {
      success: false,
      message: type === 'leave' ? '请选择请假事由' : '请填写出差地',
    };
  }
  // 请假事由只能是 7 个固定选项之一，不接受自定义文字：
  // 否则「年假 / 年休假 / 公休」会各算一类，看板与统计都无法归并。
  if (type === 'leave' && LEAVE_REASONS.indexOf(noteText) < 0) {
    return { success: false, message: '请假事由请从选项中选择' };
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
  const staffRes = await db.collection('staff').where({ openid: owner }).limit(1).get();
  if (staffRes.data.length === 0) {
    return {
      success: false,
      message: opt.ownerOpenid ? '该员工还没有认领身份' : '请先在「我的」里认领身份',
    };
  }
  const me = staffRes.data[0];

  // 取出与「新记录所在区间」相交的该员工所有记录
  const existRes = await db.collection('presence')
    .where({
      _openid: owner,
      startAt: _.lt(dayEnd(endDate)),
      endAt: _.gt(dayStart(startDate)),
    })
    .limit(PAGE_SIZE)
    .get();

  // 逐条判相交。相交判定走 overlaps()：相邻不算相交，
  // 上午 08:30-12:00 与下午 12:00-18:00 要能无缝拼上，这是半天粒度的前提。
  const conflicts = existRes.data.filter((old) =>
    overlaps(new Date(old.startAt).getTime(), new Date(old.endAt).getTime(), newStart, newEnd)
  );

  if (conflicts.length > 0 && !opt.force) {
    // 取开始最早的那条来提示，并带上时间与类型——只说「有交叉」用户不知道该去改哪条
    const c = conflicts
      .slice()
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
    return {
      success: false,
      message:
        '与 ' + recordRangeText(c) + ' 的「' + (TYPE_TEXT[c.type] || c.type) + '」有交叉，' +
        '请先删除或提前终止那条记录',
    };
  }
  if (conflicts.length > 0) {
    await resolveOverlaps(conflicts, newStart, newEnd, owner);
  }

  await db.collection('presence').add({
    data: {
      _openid: owner,
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

  // 管理员的强制覆盖会改动别人的既有记录，必须留痕——
  // 这是整套规则里唯一能绕过「交叉即拒绝」的路径。
  if (conflicts.length > 0 && opt.force) {
    await writeLog({
      actor: opt.actorOpenid || openid,
      action: 'adminOverwrite',
      targetOpenid: owner,
      byAdmin: true,
      before: { conflicts: conflicts.map(shapeForLog) },
      after: { type, startAt: new Date(newStart), endAt: new Date(newEnd), note: noteText },
    });
  }

  // 顺带回传最新的记录列表，前端直接用，省掉一次云函数调用
  return { success: true, list: await fetchMyRecords(owner) };
}

// 把与新记录相交的旧记录删掉或裁剪掉。**只有管理员「强制覆盖」才会走到这里。**
// 普通员工路径在 saveRecords 里已经直接拒绝了，这段逻辑之所以留着，
// 是为了给管理员一个「确认要改」的出口——否则员工漏记、填错就彻底没法纠正。
async function resolveOverlaps(conflicts, newStart, newEnd, owner) {
  for (const old of conflicts) {
    const os = new Date(old.startAt).getTime();
    const oe = new Date(old.endAt).getTime();

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
          _openid: owner,
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
}

// 取一条记录并校验归属，返回 { rec } 或 { err }
async function loadOwnRecord(id, owner) {
  let doc;
  try {
    doc = await db.collection('presence').doc(id).get();
  } catch (e) {
    return { err: '记录不存在' };
  }
  if (!doc.data) return { err: '记录不存在' };
  if (doc.data._openid !== owner) return { err: '只能操作自己的记录' };
  return { rec: doc.data };
}

// 写一条操作日志。
// 删除、提前终止、管理员的修改/删除/代填都会写——这是「事后查得清是谁改的」
// 唯一依据，也是这套防篡改规则的最后一道兜底。
// 日志写入失败**不能**反过来把业务操作搞挂，所以整段 try 住，只打错误日志。
async function writeLog(entry) {
  try {
    await db.collection('presence_logs').add({
      data: {
        _openid: entry.actor || '',
        action: entry.action,
        targetId: entry.targetId || '',
        targetOpenid: entry.targetOpenid || '',
        byAdmin: !!entry.byAdmin,
        before: entry.before || null,
        after: entry.after || null,
        at: db.serverDate(),
      },
    });
  } catch (e) {
    console.error('写操作日志失败', entry && entry.action, e && e.message);
  }
}

// 记录的可留痕摘要（日志里存这个，不存整个文档，避免把 _id 之类冗余信息带进去）
function shapeForLog(rec) {
  if (!rec) return null;
  return {
    type: rec.type || '',
    note: rec.note || '',
    startAt: rec.startAt ? new Date(rec.startAt).toISOString() : '',
    endAt: rec.endAt ? new Date(rec.endAt).toISOString() : '',
  };
}

// 删除一条记录。
// 规则（与前端置灰口径一致，前端只是提示，这里才是权威）：
//   还没开始 → 随便删
//   进行中   → 只有「距开始不到 5 小时」能删（给刚填错的人一个纠正窗口）
//   已结束   → 一律不能删
async function removeRecord(event, openid) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少记录 ID' };

  const found = await loadOwnRecord(id, openid);
  if (found.err) return { success: false, message: found.err };
  const rec = found.rec;

  const block = deleteBlockReason(rec, Date.now());
  if (block === 'ended') {
    return { success: false, message: '这条记录已经结束了，不能删除' };
  }
  if (block === 'window') {
    return {
      success: false,
      message:
        '已开始超过 ' + DELETE_WINDOW_HOURS +
        ' 小时，不能删除；如需提前结束，请用「提前终止」',
    };
  }

  await db.collection('presence').doc(id).remove();
  await writeLog({
    actor: openid,
    action: 'remove',
    targetId: id,
    targetOpenid: openid,
    before: shapeForLog(rec),
  });
  return { success: true, list: await fetchMyRecords(openid) };
}

// 提前终止：把结束时间收回到「当前所在半天的开始点」（见 halfStartOfNow）。
// 例：今天 08:30-18:00 的假，上午 10 点终止 → 结束时间收到 08:30 → 今天上午这半天不请假。
//
// 若收回后的时间 <= 开始时间（也就是这半天本来就还没开始），
// 整条记录都不存在「已经发生」的部分，直接删掉——留一条零长度的记录会让
// 考勤统计出现「长度 0 的格子」，半天粒度那里会算出 0 天的怪结果。
async function stopRecord(event, openid) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少记录 ID' };

  const found = await loadOwnRecord(id, openid);
  if (found.err) return { success: false, message: found.err };
  const rec = found.rec;

  const now = Date.now();
  const state = recordState(rec, now);
  if (state === 'future') return { success: false, message: '这条还没开始，直接删除即可' };
  if (state === 'ended') return { success: false, message: '这条记录已经结束了' };

  const cut = halfStartOfNow(new Date(now));
  const startTs = new Date(rec.startAt).getTime();
  const before = shapeForLog(rec);

  if (cut <= startTs) {
    await db.collection('presence').doc(id).remove();
    await writeLog({
      actor: openid,
      action: 'stop',
      targetId: id,
      targetOpenid: openid,
      before,
      after: null,
    });
    return { success: true, message: '已终止', list: await fetchMyRecords(openid) };
  }

  await db.collection('presence').doc(id).update({
    data: { endAt: new Date(cut), updatedAt: db.serverDate() },
  });
  await writeLog({
    actor: openid,
    action: 'stop',
    targetId: id,
    targetOpenid: openid,
    before,
    after: Object.assign({}, before, { endAt: new Date(cut).toISOString() }),
  });
  return { success: true, message: '已终止', list: await fetchMyRecords(openid) };
}

// ===== 管理员：记录纠错 =====
// 员工只能填今天及以后，且填错超过 5 小时就只能「终止」，漏记更没有自助途径——
// 这些情况都必须由管理员纠正，所以这组接口是那套规则的必要配套，不是可有可无。
// 所有改动记录的操作都写 presence_logs 留痕。

// 把前端传来的 staffId 解析成 openid。
// 刻意让前端传 staffId 而不是 openid：openid 没必要下发到端上，
// 而名册的 _id 本来就是管理员在界面上选人时的依据。
async function resolveTargetOpenid(event) {
  const direct = String(event.targetOpenid || '');
  if (direct) return direct;
  const id = String(event.staffId || '');
  if (!id) return '';
  try {
    const d = await db.collection('staff').doc(id).get();
    return (d.data && d.data.openid) || '';
  } catch (e) {
    return '';
  }
}

async function adminRecords(event, openid) {
  if (!(await checkAdmin(openid))) return { success: false, message: '仅管理员可用' };
  const target = await resolveTargetOpenid(event);
  if (!target) return { success: false, message: '该人员还没有认领身份' };
  return { success: true, list: await fetchMyRecords(target) };
}

async function adminRemove(event, openid) {
  if (!(await checkAdmin(openid))) return { success: false, message: '仅管理员可用' };
  const id = event.id;
  if (!id) return { success: false, message: '缺少记录 ID' };

  let doc;
  try {
    doc = await db.collection('presence').doc(id).get();
  } catch (e) {
    return { success: false, message: '记录不存在' };
  }
  if (!doc.data) return { success: false, message: '记录不存在' };
  const rec = doc.data;

  await db.collection('presence').doc(id).remove();
  await writeLog({
    actor: openid,
    action: 'adminRemove',
    targetId: id,
    targetOpenid: rec._openid || '',
    byAdmin: true,
    before: shapeForLog(rec),
  });
  return { success: true, list: await fetchMyRecords(rec._openid || '') };
}

// 管理员代填 / 代改：豁免「不能填过去」，并可用 force 覆盖交叉记录。
// 「修改」的语义是「删掉旧的 + 新建一条」（传 replaceId），
// 比在原记录上做字段级 diff 简单得多，也不会漏掉时间重叠的连带处理。
async function adminSave(event, openid) {
  if (!(await checkAdmin(openid))) return { success: false, message: '仅管理员可用' };
  const target = await resolveTargetOpenid(event);
  if (!target) return { success: false, message: '该人员还没有认领身份' };

  let replaced = null;
  const replaceId = String(event.replaceId || '');
  if (replaceId) {
    try {
      const d = await db.collection('presence').doc(replaceId).get();
      // 只允许替换属于该员工的记录，避免把 id 传错时误删别人的
      if (d.data && d.data._openid === target) {
        replaced = shapeForLog(d.data);
        await db.collection('presence').doc(replaceId).remove();
      }
    } catch (e) {
      // 记录已经不在了（别人删过）——继续往下新增即可
    }
  }

  const res = await saveRecords(event, openid, {
    allowPast: true,
    force: !!event.force,
    ownerOpenid: target,
    actorOpenid: openid,
  });

  if (replaceId && replaced) {
    await writeLog({
      actor: openid,
      action: 'adminUpdate',
      targetId: replaceId,
      targetOpenid: target,
      byAdmin: true,
      before: replaced,
      after: res && res.success ? { type: event.type, note: event.note } : null,
    });
  }
  return res;
}

// 我的近期记录，按时间倒序（含未来已填的）
// 把「我的记录」整形为前端渲染结构。
// save / remove / stop / mine 各入口共用，这样写操作可以顺带回传最新列表，
// 前端就不必再发一次云函数调用来刷新（一次冷启动能省 1~3 秒）。
//
// state / canDelete / canStop / deleteBlock **一律由服务端算好下发**：
// 判定依赖「此刻」和 5 小时窗口，云函数跑 UTC、手机是本地时区，
// 前端自己算就是第二份口径，迟早会在边界上不一致（比如刚过 5 小时那一下）。
function shapeMyRecords(rows) {
  const nowTs = Date.now();
  return rows.map((r) => {
    const s = new Date(r.startAt);
    const e = new Date(r.endAt);
    const startDate = toDateText(s);
    const endDate = toDateText(e);
    const sameDay = startDate === endDate;
    const state = recordState(r, nowTs);
    const block = deleteBlockReason(r, nowTs);
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
      // 结构化起止。管理端「修改」要回填表单，不能去解析上面那句给人看的 dateText
      // （跨天时它是「9/22 08:30 至 9/25 18:00」这种混合文本）。
      startDate,
      startTime: toMinuteText(s),
      endDate,
      endTime: toMinuteText(e),
      // future（未开始）/ active（进行中）/ ended（已结束，界面置灰）
      state,
      canDelete: block === '',
      canStop: state === 'active',
      // '' / 'ended' / 'window' —— 前端据此说明「为什么不能删」
      deleteBlock: block,
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

// ===== 导出考勤表 =====

// ---------- 手写 xlsx（零依赖）----------
//
// **刻意不用 exceljs。** 它是个很重的包：云函数冷启动时 `require` 就要吃掉几百毫秒
// 到 1 秒以上，加上生成与上传，在默认 3 秒超时下几乎必爆——实测报的就是「生成失败」。
// 而 xlsx 的本质只是「一个 zip 容器 + 几个固定 XML」，node 自带的 zlib 压一下即可，
// 生成耗时不到 10ms，还顺带免掉了「必须选『上传并部署：云端安装依赖』」这个反复踩的坑。
// 代价是下面这一百多行，换来零第三方依赖。
//
// 生成的表：表头加粗 + 灰底、全表居中带细边框、首行冻结、固定列宽。

// CRC32 查表（zip 每个成员都要带一个）。node 的 `zlib.crc32` 是 20.15 才加的，
// 云函数运行时版本不确定，自己算最稳。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// zip 打包：一堆「内存里的文件」→ 一个 Buffer。
// 只实现本地头 + 中央目录 + 结尾记录，省掉 zip64 / 注释 / 额外字段等用不到的分支。
function zipFiles(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  // DOS 时间戳。云函数跑在 UTC，加 8 小时才是本地时间；
  // 它只影响 Excel 里显示的「修改时间」，但没必要让它错 8 小时。
  const now = new Date(Date.now() + 8 * 3600000);
  const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const dosDate =
    ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();

  files.forEach((f) => {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // bit11：文件名按 UTF-8 解
    local.writeUInt16LE(8, 8); // 压缩方式 8 = deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 额外字段长度
    parts.push(local, name, deflated);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // 中央目录项签名
    cen.writeUInt16LE(20, 4); // 生成程序版本
    cen.writeUInt16LE(20, 6); // 解压所需版本
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 38); // 外部属性
    cen.writeUInt32LE(offset, 42); // 本地头在文件里的偏移
    central.push(cen, name);

    offset += local.length + name.length + deflated.length;
  });

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结尾签名
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cd, end]);
}

// XML 文本转义。姓名、工号要写进 <t> 里，& 和 < 不转义会直接写坏文件。
// 顺带剥掉 XML 1.0 不允许的控制字符（从别处粘贴带进来的 \x0b 之类）。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 1 → A、27 → AA。现在只有 12 列，写通用些免得以后加列踩边界。
function colName(n) {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 样式表。三个样式：0 默认 / 1 表头（加粗 + 灰底 + 边框）/ 2 数据（边框）。
// ⚠️ fills 的前两项必须是 none 和 gray125，这是 Excel 的硬约定，少一个文件会被判为损坏。
const XLSX_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
  '<font><b/><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFB0B0B0"/></left><right style="thin"><color rgb="FFB0B0B0"/></right>' +
  '<top style="thin"><color rgb="FFB0B0B0"/></top><bottom style="thin"><color rgb="FFB0B0B0"/></bottom>' +
  '<diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="center" vertical="center"/></xf>' +
  '</cellXfs>' +
  // 不写这一句 Excel 也能打开，但 openpyxl 会警告「Workbook contains no default style」，
  // 补上更规范（常规 = builtinId 0）。
  '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

// 生成考勤表的 xlsx，返回 Buffer（文件由调用方上传）。
// 第一行是表头，行数 = 1 + 人数。
function buildWorkbook(month, rows, dates) {
  // dates 只用来做参数防御（列数由 headers 决定），避免误删参数后无人察觉。
  if (!dates || !dates.length) throw new Error('缺少统计日期');

  const headers = ['序号', '工号', '姓名', '出勤'].concat(LEAVE_COLS).concat(['小计']);
  const widthOf = (h) => {
    if (h === '序号') return 6;
    if (h === '工号') return 14;
    if (h === '姓名') return 11;
    return 10;
  };

  // 折算出来的天数只可能是 0.5 的倍数（最小单位 0.5 天），一位小数就装得下。
  // 这里仍规整到**两位**，是为了兼容出勤列可能带的 0.05 级尾部
  // （出勤走减法倒推，历史数据里可能留 0.65 / 1.35 这类旧口径的值）。
  // ⚠️ 早先是 `* 10 / 10`（一位），换成 0.05 刻度口径且不改的话会**静默把
  // 0.35 写成 0.4** —— 这类「旧口径的格式化函数残留」是改口径时最容易漏的地方。
  const num = (v) => (Math.round(Number(v) * 100) / 100).toString();
  const cell = (col, row, value, styleId) => {
    const ref = colName(col) + row;
    if (typeof value === 'number') {
      return '<c r="' + ref + '" s="' + styleId + '"><v>' + num(value) + '</v></c>';
    }
    const text = value == null ? '' : String(value);
    // 空值（比如还没补工号的人）写成空单元格，而不是空的 <is><t></t>：
    // 空的 inlineStr 会让部分解析器把这格当成「不存在」，读回时看着像列错位。
    if (text === '') return '<c r="' + ref + '" s="' + styleId + '"/>';
    return (
      '<c r="' + ref + '" s="' + styleId + '" t="inlineStr"><is><t xml:space="preserve">' +
      esc(text) +
      '</t></is></c>'
    );
  };

  const rowXml = [
    '<row r="1" ht="24" customHeight="1">' +
      headers.map((h, j) => cell(j + 1, 1, h, 1)).join('') +
      '</row>',
  ];
  rows.forEach((r, i) => {
    const cells = [i + 1, r.jobNo, r.name, r.office]
      .concat(LEAVE_COLS.map((c) => r[c]))
      .concat([r.total]);
    rowXml.push(
      '<row r="' + (i + 2) + '" ht="20" customHeight="1">' +
        cells.map((v, j) => cell(j + 1, i + 2, v, 2)).join('') +
        '</row>'
    );
  });

  const cols =
    '<cols>' +
    headers
      .map(
        (h, j) =>
          '<col min="' + (j + 1) + '" max="' + (j + 1) + '" width="' + widthOf(h) + '" customWidth="1"/>'
      )
      .join('') +
    '</cols>';

  // ⚠️ worksheet 的子元素顺序是规定死的：sheetViews → sheetFormatPr → cols → sheetData。
  // 调换顺序 Excel 会报「文件已损坏」。
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    // 冻结首行：人多了往下滚还能看见表头
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    '<sheetData>' + rowXml.join('') + '</sheetData>' +
    '</worksheet>';

  // 工作表名：31 字符上限，且不许含 []:*?/\
  const sheetName = String(month).slice(0, 28).replace(/[\[\]:*?\/\\]/g, '-');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  return zipFiles([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: XLSX_STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// 导出某月考勤表。只有管理员能导。
//
// dates 由小程序端算好传进来——工作日的判定依赖节假日表（holidays.js），
// 那份数据只存在于小程序端；云函数再存一份就是第四个副本，必然会漏更新。
//
// 文件固定放在云存储 attendance/ 下、按月份命名：同一月份重复导出会覆盖上一次的
// 文件，不会越积越多。
async function exportAttendance(event, openid) {
  if (!(await checkAdmin(openid))) return { success: false, message: '仅管理员可导出' };

  // 兜住 runExport 内部抛出的异常，把原因回传。
  // 以前这里是直接往外抛：云函数调用整体失败，前端只能显示笼统的「生成失败，请重试」，
  // 等于什么都没说，出问题时无从下手（db 查询 / 建表 / 上传，三种挂法一个提示）。
  // ⚠️ 这条路兜不住「云函数执行超时」——超时是平台终止进程、函数没机会 return，
  // 只能由前端按 errCode 认出来（见 manage.js 的 doExport）。
  try {
    return await runExport(event);
  } catch (e) {
    console.error('[export] 导出失败', e);
    return {
      success: false,
      message: '导出失败：' + ((e && (e.message || e.errMsg)) || '未知错误'),
    };
  }
}

// 真正的导出流程。单独拆出来，是为了让 exportAttendance 能统一兜异常。
async function runExport(event) {
  const month = String(event.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return { success: false, message: '月份格式不对' };

  const dates = (event.dates || [])
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (dates.length === 0) return { success: false, message: '该月没有可统计的工作日' };

  const first = dates[0];
  const last = dates[dates.length - 1];

  const staffList = await fetchAll('staff', { active: _.neq(false) });
  // 只拉与统计区间相交的记录。跨月的长记录（如 8/30-9/2 出差）也要拉回来，
  // 否则 9/1、9/2 会被当成「没有记录」而漏算出勤——并不会算错，但无法区分。
  const records = await fetchAll('presence', {
    startAt: _.lt(dayEnd(last)),
    endAt: _.gt(dayStart(first)),
  });

  const rows = buildAttendance(staffList, records, dates);

  // 手写 xlsx：同步、零依赖、毫秒级，所以这里不需要再兜「忘了云端安装依赖」。
  const buffer = buildWorkbook(month, rows, dates);

  const fileName = '考勤表-' + month + '.xlsx';
  const up = await cloud.uploadFile({
    cloudPath: 'attendance/' + fileName,
    fileContent: buffer,
  });

  return {
    success: true,
    fileID: up.fileID,
    fileName,
    dayCount: dates.length,
    peopleCount: rows.length,
    lastDate: last,
  };
}

