// 日期工具。
// 注意：统一用 'YYYY-MM-DDTHH:mm:00' 这种 ISO 格式构造 Date，
// 不要用 'YYYY-MM-DD HH:mm:00'——后者在 iOS 上会解析失败返回 Invalid Date。

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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

function isWorkday(dateStr) {
  const day = parseDay(dateStr).getDay();
  return day >= 1 && day <= 5;
}

// 从 dateStr 起往前取 n 个工作日（含当天，若当天是工作日），按时间正序返回。
// 注意：看板第二屏用的是下面的 nextWorkdays（往后取），不是这个，别拿错。
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
// 今天不是工作日（周末）时从下一个工作日算起，例如周六看到的是 [周一, 周二, 周三]。
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
  recentWorkdays,
  nextWorkdays,
  dayRelativeText,
  addDays,
  daysBetween,
  dayLabel,
};
