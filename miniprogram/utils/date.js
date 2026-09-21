// 日期工具。
// 注意：统一用 'YYYY-MM-DDTHH:mm:00' 这种 ISO 格式构造 Date，
// 不要用 'YYYY-MM-DD HH:mm:00'——后者在 iOS 上会解析失败返回 Invalid Date。

const holiday = require('./holidays');

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 已经告警过的年份，避免一次渲染里同一个年份刷屏
const warnedYears = {};

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function today() {
  return formatDate(new Date());
}

// 'YYYY-MM-DD' -> 当天 00:00 的 Date
function parseDay(dateStr) {
  return new Date(dateStr + 'T00:00:00');
}

// 当天 00:00 的时间戳
function dayStartTs(dateStr) {
  return parseDay(dateStr).getTime();
}

// 当天 23:59:59.999 的时间戳
function dayEndTs(dateStr) {
  return dayStartTs(dateStr) + 24 * 60 * 60 * 1000 - 1;
}

function weekdayText(dateStr) {
  return WEEK_CN[parseDay(dateStr).getDay()];
}

// '2026-09-14' -> '9月14日'
function dayDisplay(dateStr) {
  const parts = dateStr.split('-');
  return Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

// '2026-09-14' -> '9/14'
function dayShort(dateStr) {
  const parts = dateStr.split('-');
  return Number(parts[1]) + '/' + Number(parts[2]);
}

// 缺年份数据时告警一次（每年 11 月国务院发布次年安排，需要人工补 utils/holidays.js）
function warnMissingHolidayData(year) {
  if (warnedYears[year]) return;
  warnedYears[year] = true;
  console.warn(
    '[date] 缺少 ' + year + ' 年的节假日数据，已按「周一~周五」兜底。' +
      '请把国务院公布的次年安排补进 utils/holidays.js。'
  );
}

// 工作日判定：先查节假日表，再按周一~周五。
//   - 法定节假日 / 调休放假 → 不是工作日
//   - 调休上班的周末（如 2026-10-10 周六） → 是工作日
// 数据表见 utils/holidays.js，需每年更新一次。
function isWorkday(dateStr) {
  if (holiday.isOffDay(dateStr)) return false;
  if (holiday.isMakeupWorkday(dateStr)) return true;
  const year = Number(dateStr.slice(0, 4));
  if (!holiday.hasDataFor(year)) warnMissingHolidayData(year);
  const day = parseDay(dateStr).getDay();
  return day >= 1 && day <= 5;
}

// 调休上班的周末。看板列头用它在日期后面加个「班」标记，
// 否则「10/10 周六」排在工作日列里看着像算错了。
function isMakeupWorkday(dateStr) {
  return holiday.isMakeupWorkday(dateStr);
}

// 节假日名（如「中秋节」），不是放假日返回 ''
function holidayName(dateStr) {
  return holiday.offDayName(dateStr);
}

// 从 dateStr 起往前取 n 个工作日（含当天，若当天是工作日），按时间正序返回。
// 注意：看板第二屏用的是下面的 nextWorkdays（往后取），不是这个，别拿错。
// 工作日判定与 nextWorkdays 一致，同样走 isWorkday（含节假日/调休）。
function recentWorkdays(n, dateStr) {
  const base = dateStr || today();
  const out = [];
  const d = parseDay(base);
  let guard = 0;
  while (out.length < n && guard < 60) {
    const cur = formatDate(d);
    if (isWorkday(cur)) out.push(cur);
    d.setDate(d.getDate() - 1);
    guard++;
  }
  return out.reverse();
}

// 从 dateStr 起**往后**取 n 个工作日（含当天，若当天是工作日），按时间正序返回。
// 看板第二屏用它：今天排最左，往右依次是明天、后天。
//
// 「工作日」的判定见 isWorkday：周一~周五，剔除法定节假日 / 调休放假，
// 并算上调休上班的周末。所以：
//   - 今天不是工作日时从下一个工作日算起（如周六看到 [周一, 周二, 周三]）；
//   - 遇到长假会自动跳过去，如 9/23（周三）看到 [9/23, 9/24, 9/28]（跳开中秋 9/25~9/27）。
function nextWorkdays(n, dateStr) {
  const base = dateStr || today();
  const out = [];
  const d = parseDay(base);
  let guard = 0;
  while (out.length < n && guard < 60) {
    const cur = formatDate(d);
    if (isWorkday(cur)) out.push(cur);
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return out;
}

// 是否周末（周六/周日）。注意调休上班的周末也是周末——
// 只是 isWorkday() 会把它们算成工作日，两者用途不同别混用。
function isWeekend(dateStr) {
  const day = parseDay(dateStr).getDay();
  return day === 0 || day === 6;
}

// 从 dateStr 起**往后**取 n 个自然日（含当天），按时间正序返回。
// 与 nextWorkdays 的区别：不跳过周末和节假日——「一个月」视图要的就是
// 连续的日历格子，周末/节假日由界面涂灰，而不是从数据里消失。
function nextDays(n, dateStr) {
  const base = dateStr || today();
  const out = [];
  const d = parseDay(base);
  for (let i = 0; i < n; i++) {
    out.push(formatDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// 相对今天的友好描述
function dayRelativeText(dateStr) {
  const diff = Math.round((dayStartTs(dateStr) - dayStartTs(today())) / 86400000);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  if (diff === -2) return '前天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return '';
}

// 'YYYY-MM-DD' 加减天数
function addDays(dateStr, n) {
  const d = parseDay(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

// 两个日期相差几天（b - a），用于算时间跨度
function daysBetween(a, b) {
  return Math.round((dayStartTs(b) - dayStartTs(a)) / 86400000);
}

// '2026-09-14' -> '今天 9月14日' / '明天 9月15日' / '9月20日 周日'
function dayLabel(dateStr) {
  const rel = dayRelativeText(dateStr);
  const display = dayDisplay(dateStr);
  if (rel) return rel + ' ' + display;
  return display + ' ' + weekdayText(dateStr);
}

module.exports = {
  WEEK_CN,
  formatDate,
  today,
  parseDay,
  dayStartTs,
  dayEndTs,
  weekdayText,
  dayDisplay,
  dayShort,
  isWorkday,
  isMakeupWorkday,
  holidayName,
  isWeekend,
  recentWorkdays,
  nextWorkdays,
  nextDays,
  dayRelativeText,
  addDays,
  daysBetween,
  dayLabel,
};
