// 中国法定节假日 / 调休上班日数据表。
//
// 【数据来源】国务院办公厅关于 2026 年部分节假日安排的通知
//   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
//   2026 年放假调休共 33 天，另有 6 个周末调休上班。
//
// 【每年怎么更新】国务院一般在每年 10~11 月发布下一年的安排。拿到通知后：
//   1) 把新一年的放假区间整段加进 OFF_RANGES（通知里怎么写就怎么抄）；
//   2) 把「周末上班」的日期加进 WORK_DAYS；
//   3) 把新年份加进 DATA_YEARS —— date.js 用它判断数据是否齐备，
//      缺年份会 console.warn 并退回「周一~周五」的常规规则，不至于整个看板不可用。
//   只改这张表，不需要动任何逻辑代码。
//
// 【为什么用本地表而不是接口】看板早上 8:30 就要用，不能受网络抖动影响；
//   小程序调外部接口还要配 request 合法域名，为一年变一次的数据不值得。
//   表很小（一年 40 来条），本地查表零成本。

// 放假区间：[开始日期, 结束日期, 节假日名]，含首尾。
// 一律照抄国务院通知里的表述，便于逐年核对。
const OFF_RANGES = [
  ['2026-01-01', '2026-01-03', '元旦'],
  ['2026-02-15', '2026-02-23', '春节'],
  ['2026-04-04', '2026-04-06', '清明节'],
  ['2026-05-01', '2026-05-05', '劳动节'],
  ['2026-06-19', '2026-06-21', '端午节'],
  ['2026-09-25', '2026-09-27', '中秋节'],
  ['2026-10-01', '2026-10-07', '国庆节'],
];

// 调休上班的周末：本来是休息日，通知里要求上班。
// 这些日期即使落在周六/周日，也要按工作日处理。
const WORK_DAYS = {
  '2026-01-04': '元旦调休',
  '2026-02-14': '春节调休',
  '2026-02-28': '春节调休',
  '2026-05-09': '劳动节调休',
  '2026-09-20': '国庆调休',
  '2026-10-10': '国庆调休',
};

// 表里已经覆盖的年份。新年份要在这里登记，否则 date.js 会告警。
const DATA_YEARS = [2026];

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function toDateText(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function parseDay(dateStr) {
  // 与 utils/date.js 保持一致：必须带 T00:00:00，否则 iOS 上解析失败
  return new Date(dateStr + 'T00:00:00');
}

// 把区间展开成「日期 -> 节假日名」的查询表。模块加载时算一次。
const OFF_DAYS = {};
OFF_RANGES.forEach((item) => {
  const name = item[2];
  const d = parseDay(item[0]);
  const end = parseDay(item[1]);
  while (d.getTime() <= end.getTime()) {
    OFF_DAYS[toDateText(d)] = name;
    d.setDate(d.getDate() + 1);
  }
});

function hasDataFor(year) {
  return DATA_YEARS.indexOf(year) >= 0;
}

// 是否是放假日（法定节假日 + 调休放假）
function isOffDay(dateStr) {
  return !!OFF_DAYS[dateStr];
}

// 放假日对应的节假日名，不是放假日返回 ''
function offDayName(dateStr) {
  return OFF_DAYS[dateStr] || '';
}

// 是否是调休上班的周末
function isMakeupWorkday(dateStr) {
  return !!WORK_DAYS[dateStr];
}

// 调休上班日的说明，不是则返回 ''
function makeupName(dateStr) {
  return WORK_DAYS[dateStr] || '';
}

module.exports = {
  OFF_RANGES,
  OFF_DAYS,
  WORK_DAYS,
  DATA_YEARS,
  hasDataFor,
  isOffDay,
  offDayName,
  isMakeupWorkday,
  makeupName,
};
