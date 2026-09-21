// 名册文本解析 + 工号规范化。
//
// 独立成纯函数模块（不碰 wx / Page），这样可以用 Node 直接 require 单测。
//
// 名册每行一个人，要识别出「姓名 / 工号 / 科室」三列。**不按固定列序**：
// 从 Excel 复制过来的列序五花八门（姓名,工号,科室 / 工号,姓名,科室 / 姓名,科室,工号
// 都见过），按位置硬编码会在某些行静默错位——把工号当成姓名导进去，
// 而且因为三列都"有值"不会报错，等到有人认领不上才会发现。
// 所以改成按「列的角色」识别：先摘科室（能命中别名表的），再摘工号（像工号的），
// 剩下的第一列就是姓名。

// 科室别名表：容忍「一室」「1 室」「办公室」等常见写法。
// 与 login / staff 云函数里的 DEPTS 是两回事：那份是「合法科室清单」，
// 这份是「把各种写法映射到清单上的写法表」。
const DEPT_ALIAS = {
  '1室': '1室', '一室': '1室', '1': '1室',
  '2室': '2室', '二室': '2室', '2': '2室',
  '3室': '3室', '三室': '3室', '3': '3室',
  '4室': '4室', '四室': '4室', '4': '4室',
  '部办': '部办', '办公室': '部办', '部办理': '部办',
};

function normalizeDept(raw) {
  const t = String(raw || '').replace(/\s/g, '');
  return DEPT_ALIAS[t] || t;
}

// 工号的合法长度上限（存储用）
const JOB_NO_MAX = 20;

// 工号归一化：去掉空格、横线、下划线，字母统一大写。
// 归一化后只允许字母和数字，2~20 位。
// 用途有二：① 认领时把用户手打的工号和名册里的工号按同一形式比对
//（允许他写成 "a-100" 而名册里是 "A100"）；
// ② 导入时判重，避免 "A100" 和 "a 100" 被当成两个人。
//
// 同一条规则在 login 与 staff 两个云函数里各有一份实现
//（云函数不能 require 小程序端代码）——三处必须逐字一致，
// 单测里有一条断言专门比对它们，改规则时别只改一处。
function normalizeJobNo(raw) {
  const t = String(raw || '').replace(/[\s\-_]/g, '').toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(t) ? t : '';
}

// 这一段文本「看起来像工号吗」——只用于名册解析时逐列认领角色。
// 比 normalizeJobNo 宽松：允许字母数字混排、允许中间有分隔符（A-100 这种写法），
// 但**必须含至少一位数字**——否则「部办」这类纯字母的科室、
// 以及极少数纯字母的姓名也会被认成工号，把整行错位。
// 代价是「纯字母的工号」识别不出来，会归到 missing 里提示用户检查。
const LOOKS_LIKE_JOB_NO = /^[A-Za-z0-9][A-Za-z0-9\-_]{0,19}$/;

function looksLikeJobNo(raw) {
  const t = String(raw || '').trim();
  return /\d/.test(t) && LOOKS_LIKE_JOB_NO.test(t);
}

// 解析粘贴进来的名册文本。每行一个人，列之间支持：
//   Excel 复制的制表符、中英文逗号、分号、空格
// 返回：
//   items   能同时认出「姓名 + 工号」的行（科室可能还没归一化成功，
//           留给云函数去校验——那里才有权威的科室清单，前端不重复维护一份）
//   bad     连两列都凑不出来的行（原文）
//   missing 能拆成多列、但认不出工号（或认不出姓名）的行（原文）
//           常见于还在用旧格式「张三,1室」——工号现在是导入必填项
function parseRoster(text) {
  const items = [];
  const bad = [];
  const missing = [];

  String(text || '').split('\n').forEach((line) => {
    const raw = line.trim();
    if (!raw) return;

    let parts = raw.split(/[\t,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      parts = raw.split(/\s+/).filter(Boolean);
    }
    if (parts.length < 2) {
      bad.push(raw);
      return;
    }

    // ① 科室：第一个能命中别名表的列
    let deptIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (DEPT_ALIAS[parts[i].replace(/\s/g, '')]) {
        deptIdx = i;
        break;
      }
    }

    // ② 工号：剩下的列里第一个「像工号」的
    let jobNoIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (i === deptIdx) continue;
      if (looksLikeJobNo(parts[i])) {
        jobNoIdx = i;
        break;
      }
    }

    // ③ 姓名：把科室和工号摘掉之后，剩下的第一列
    let nameIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (i === deptIdx || i === jobNoIdx) continue;
      nameIdx = i;
      break;
    }

    if (nameIdx < 0 || jobNoIdx < 0) {
      missing.push(raw);
      return;
    }

    items.push({
      name: parts[nameIdx],
      jobNo: normalizeJobNo(parts[jobNoIdx]),
      dept: deptIdx >= 0 ? normalizeDept(parts[deptIdx]) : '',
    });
  });

  return { items, bad, missing };
}

module.exports = {
  DEPT_ALIAS,
  normalizeDept,
  normalizeJobNo,
  looksLikeJobNo,
  parseRoster,
  JOB_NO_MAX,
};
