// 时间轴与状态定义。
// 时间轴：8:30 - 18:00，每 30 分钟一段，共 19 段。
// 这个粒度和会议室预约系统一致，避免用户填写 9:15 这类无法对齐的时间。

const dateUtil = require('./date');

const DAY_START_MINUTES = 8 * 60 + 30; // 510
const DAY_END_MINUTES = 18 * 60; // 1080
const STEP_MINUTES = 30;
const SLOT_COUNT = (DAY_END_MINUTES - DAY_START_MINUTES) / STEP_MINUTES; // 19

// 四种去向状态。dotClass 直接给 WXML 当 class 用，
// 避免在模板里写条件表达式（WXML 表达式能力有限）。
//
// 这张表是「类型 → 中文名 / 配色」的**显示映射**，必须包含 office：
// 历史记录里存过 office，删掉它这些记录在看板和「我的记录」里会变成空白标签。
//
// 配色：在岗=绿 · 京内出差=黄 · 京外出差=红 · 请假=灰。
// 这里的 color/bg/text 只作备查，**页面样式里是写死的十六进制**（WXSS 拿不到 JS 常量）。
// 改颜色要同步四张表：这里 / app.wxss 的 --st-* / pages/board/board.wxss / pages/fill/fill.wxss。
const TYPES = [
  {
    value: 'office',
    label: '在办公室',
    short: '在岗',
    dotClass: 'd-office',
    color: '#2f8f5b',
    bg: '#e6f4ec',
    text: '#185e3c',
  },
  {
    value: 'meeting',
    label: '京内出差',
    short: '京内',
    dotClass: 'd-meeting',
    color: '#c08a00',
    bg: '#fef3c7',
    text: '#7a5a08',
  },
  {
    value: 'trip',
    label: '京外出差',
    short: '京外',
    dotClass: 'd-trip',
    color: '#c0392b',
    bg: '#fbe9e7',
    text: '#8d2119',
  },
  {
    value: 'leave',
    label: '请假',
    short: '请假',
    dotClass: 'd-leave',
    color: '#6f6e68',
    bg: '#f1efe8',
    text: '#444441',
  },
];

const TYPE_MAP = {};
TYPES.forEach((t) => {
  TYPE_MAP[t.value] = t;
});

// 填写页可选的去向。
// 「在办公室」不在其中——它是默认状态（不填即视为在岗），不需要填报，
// 所以填写页只提供上面三种「不在办公室」的情形。
const PICK_TYPES = ['meeting', 'trip', 'leave'];

// 可填报类型的完整定义列表，供填写页渲染按钮
function pickableTypes() {
  return PICK_TYPES.map((v) => TYPE_MAP[v]).filter((t) => !!t);
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function minutesToText(min) {
  return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
}

// 第 i 段的起始时间，如 0 -> '08:30'
function slotStartText(i) {
  return minutesToText(DAY_START_MINUTES + i * STEP_MINUTES);
}

// 第 i 段的结束时间，如 0 -> '09:00'
function slotEndText(i) {
  return minutesToText(DAY_START_MINUTES + (i + 1) * STEP_MINUTES);
}

// 第 i 段的展示文本，如 0 -> '08:30-09:00'
function slotRangeText(i) {
  return slotStartText(i) + '-' + slotEndText(i);
}

// 所有可选时间点（19 段的起点），供填写页做选择器
function allSlotStarts() {
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    out.push({ index: i, text: slotStartText(i) });
  }
  return out;
}

// 所有可选结束时间，含 18:00（比段数多一个）
function allSlotEnds() {
  const out = [];
  for (let i = 0; i <= SLOT_COUNT; i++) {
    out.push({ index: i, text: minutesToText(DAY_START_MINUTES + i * STEP_MINUTES) });
  }
  return out;
}

// 'HH:MM' -> 段索引；非整段（如 09:15）返回 -1
function textToSlot(t) {
  if (!t) return -1;
  const parts = String(t).split(':');
  if (parts.length !== 2) return -1;
  const min = Number(parts[0]) * 60 + Number(parts[1]);
  const diff = min - DAY_START_MINUTES;
  if (diff < 0 || diff % STEP_MINUTES !== 0) return -1;
  const idx = diff / STEP_MINUTES;
  return idx > SLOT_COUNT ? -1 : idx;
}

// 把服务端返回的分段补齐成「覆盖整条时间轴」的分段序列。
//
// 为什么需要它：服务端的 mergeSegments 会**跳过没有记录的空档**，
// 只返回「有状态的那几段」。而第二屏的色条是按 span 比例平铺在一条固定宽度的条里的
// （flex 布局，flex-basis:0），空档不补回来，剩下的色块就会被拉伸铺满整条——
// 表现就是「上午出差、下午在岗」，整条却全显示成出差色。
//
// gapType 传 '' 表示空档本身没有状态：由调用方（segClass）决定怎么上色——
// 已认领的人空档按在岗（绿）显示，未认领的人整条都是空的。
function barsFromSegments(segments, gapType) {
  const gap = gapType || '';
  const raw = [];
  const push = (type, span) => {
    if (span > 0) raw.push({ type, span });
  };

  let cursor = 0;
  (segments || []).forEach((s) => {
    const a = textToSlot(s.start);
    const b = textToSlot(s.end);
    // '18:00' 会被 textToSlot 解析成 19（等于 SLOT_COUNT），正是右边界，不用特殊处理
    if (a < 0 || b < 0 || b <= a) return;
    if (a > cursor) push(gap, a - cursor);
    push(s.type, b - a);
    if (b > cursor) cursor = b;
  });
  if (cursor < SLOT_COUNT) push(gap, SLOT_COUNT - cursor);

  // 相邻同色合并：100 人 × 3 天，节点越少渲染越快
  const out = [];
  raw.forEach((b) => {
    const last = out[out.length - 1];
    if (last && last.type === b.type) last.span += b.span;
    else out.push({ type: b.type, span: b.span });
  });
  return out;
}

// 状态中文名，取不到时返回空串（WXML 里不做兜底判断）
function typeLabel(type) {
  const t = TYPE_MAP[type];
  return t ? t.label : '';
}

function typeShort(type) {
  const t = TYPE_MAP[type];
  return t ? t.short : '';
}

// 把一组 presence 记录摊平成 19 个格子。
// 返回 { dots: [...type], confirmed: bool }
// dots 元素为状态值，空格子为 ''。
function buildDots(records) {
  const dots = [];
  for (let i = 0; i < SLOT_COUNT; i++) dots.push('');

  records.forEach((r) => {
    const s = textToSlot(r.startTime);
    let e = textToSlot(r.endTime);
    if (s < 0) return;
    if (e < 0) {
      // 结束时间可能是 18:00，textToSlot 会返回 19（越界），这里单独兜底
      if (r.endTime === minutesToText(DAY_END_MINUTES)) e = SLOT_COUNT;
      else return;
    }
    for (let i = s; i < e && i < SLOT_COUNT; i++) {
      dots[i] = r.type;
    }
  });

  return dots;
}

// 「一个月」视图的格子配色 class。
// 优先级：真实的不在岗记录 > 周末/节假日（空心格） > 在岗（绿）。
// 周末/节假日不再用灰色：灰已经被「请假」占用，同屏两种灰会被看成同一个状态，
// 现在改成空心格（透明底 + 描边），见 board.wxss 的 .mc-rest。
// 注意调休上班的周末（如 10/10 周六）按工作日算，不算节假日。
// 独立成纯函数是为了能被测试脚本直接 require 验证。
function monthCellClass(mark, dateStr, joined) {
  if (!joined) return 'mc-blank';
  if (mark) return 'mc-' + mark;
  const rest = dateUtil.holidayName(dateStr) ||
    (dateUtil.isWeekend(dateStr) && !dateUtil.isMakeupWorkday(dateStr));
  return rest ? 'mc-rest' : 'mc-office';
}

module.exports = {
  DAY_START_MINUTES,
  DAY_END_MINUTES,
  STEP_MINUTES,
  SLOT_COUNT,
  TYPES,
  TYPE_MAP,
  PICK_TYPES,
  pickableTypes,
  pad,
  minutesToText,
  slotStartText,
  slotEndText,
  slotRangeText,
  allSlotStarts,
  allSlotEnds,
  textToSlot,
  barsFromSegments,
  typeLabel,
  typeShort,
  buildDots,
  monthCellClass,
};
