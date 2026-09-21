const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 与 login 云函数保持一致
const DEPTS = ['1室', '2室', '3室', '4室', '部办'];
const PAGE_SIZE = 100;
const PAGE_GUARD = 30;
const MAX_BATCH = 300;

// 工号规范化：去掉空格、横线、下划线，字母统一大写。
//
// 与 login 云函数里的同名函数、以及小程序端 utils/roster.js 的那份
// 必须**逐字一致**（云函数不能 require 小程序端代码，所以只能各存一份）。
// 三处不一致的后果是「名册里存的是 A100，用户打 a-100 认领却被判错」。
// 单测里有一条断言专门比对实现，改规则时别忘了同步另外两处。
function normalizeJobNo(raw) {
  const t = String(raw || '').replace(/[\s\-_]/g, '').toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(t) ? t : '';
}

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

async function fetchAll(where, orderField) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < PAGE_GUARD; i++) {
    let q = db.collection('staff').where(where);
    if (orderField) q = q.orderBy(orderField, 'asc');
    const res = await q.skip(skip).limit(PAGE_SIZE).get();
    out.push(...res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return out;
}

function shape(doc) {
  return {
    _id: doc._id,
    name: doc.name || '',
    dept: doc.dept || '',
    // 工号由管理员导入（必填），是本人认领时的核对凭据。
    // 这里回传给**管理员**名册列表是必要的——要让他看到谁缺工号、好去补。
    jobNo: doc.jobNo || '',
    phone: doc.phone || '',
    openid: doc.openid || '',
    isAdmin: !!doc.isAdmin,
    claimed: !!doc.openid,
    active: doc.active !== false,
  };
}

// 注意：电话号码**不由管理员录入**，它是用户个人资料，由本人在认领身份时填写、
// 之后在「我的 → 编辑我的资料」里自行修改（见 login 云函数）。
// 这里只负责把 phone 透传给名册列表，方便管理员在需要时联系同事。
//
// 工号正好相反：由管理员录入、本人不能改（认领时只能填一遍做核对）。

exports.main = async (event) => {
  await ensureCollections();

  const { OPENID } = cloud.getWXContext();
  const action = event && event.action;

  // 认领页只需要未认领列表，任何人都能读；其余操作都要管理员
  if (action === 'claimable') {
    return claimableList(event);
  }

  const admin = await checkAdmin(OPENID);
  if (!admin) {
    return { success: false, message: '仅管理员可操作' };
  }

  switch (action) {
    case 'list':
      return adminList(event);
    case 'add':
      return addOne(event);
    case 'addBatch':
      return addBatch(event);
    case 'update':
      return updateOne(event);
    case 'remove':
      return removeOne(event, OPENID);
    case 'setAdmin':
      return setAdmin(event, OPENID);
    case 'fixAdmins':
      return fixAdmins(OPENID);
    case 'clearUnclaimed':
      return clearUnclaimed();
    default:
      return { success: false, message: '未知操作' };
  }
};

async function checkAdmin(openid) {
  if (!openid) return false;
  const res = await db.collection('staff').where({ openid, isAdmin: true }).limit(1).get();
  return res.data.length > 0;
}

// 未认领的判定：openid 为空串。
// 通过本小程序的管理页导入名册时一定会写入 openid: ''，
// 因此这里用空串精确匹配最稳；若在云开发控制台手工造数据，请记得带上该字段。
function unclaimedWhere(extra) {
  const base = { openid: '' };
  return extra ? Object.assign({}, base, extra) : base;
}

// 供认领页使用：列出尚未被认领的人
async function claimableList(event) {
  const list = await fetchAll(unclaimedWhere(event.dept ? { dept: event.dept } : null), 'sort');
  return {
    success: true,
    deptOptions: DEPTS,
    // 只回传认领必需字段。
    // ⚠️ 绝不能带 jobNo：认领时是拿用户填的工号和名册里的值比对，
    // 这个接口谁都能调，把工号一起下发就等于把答案贴在了题面上。
    list: list.map((d) => ({ _id: d._id, name: d.name, dept: d.dept })),
  };
}

async function adminList(event) {
  const where = {};
  if (event.dept) where.dept = event.dept;
  let list = await fetchAll(where, 'sort');
  if (event.keyword) {
    // 工号也参与搜索（大小写不敏感，名册里存 A100、搜 a100 也能搜到）
    const kw = String(event.keyword).trim();
    const low = kw.toLowerCase();
    list = list.filter(
      (d) =>
        (d.name || '').indexOf(kw) >= 0 ||
        (d.dept || '').indexOf(kw) >= 0 ||
        (d.jobNo || '').toLowerCase().indexOf(low) >= 0
    );
  }
  return { success: true, list: list.map(shape), deptOptions: DEPTS };
}

async function addOne(event) {
  const name = String(event.name || '').trim().slice(0, 20);
  const dept = String(event.dept || '').trim();
  if (!name) return { success: false, message: '请填写姓名' };
  if (DEPTS.indexOf(dept) < 0) return { success: false, message: '科室不正确' };

  // 工号必填：本人认领时要填工号与名册比对，缺了这个人就认领不了。
  const jobNo = normalizeJobNo(event.jobNo);
  if (!jobNo) return { success: false, message: '请填写工号（2-20 位字母或数字）' };

  const exist = await db.collection('staff').where({ name, dept }).limit(1).get();
  if (exist.data.length > 0) return { success: false, message: '该人员已存在' };

  // 工号在部门内唯一：两个人都挂同一个工号时，认领判断就分不清该放谁进来
  const dup = await db.collection('staff').where({ jobNo }).limit(1).get();
  if (dup.data.length > 0) return { success: false, message: '该工号已被名册中其他人员占用' };

  await db.collection('staff').add({
    data: {
      name,
      dept,
      jobNo,
      // phone 留空，由本人认领后自行填写
      phone: '',
      openid: '',
      isAdmin: false,
      active: true,
      sort: Date.now(),
      createdAt: db.serverDate(),
    },
  });
  return { success: true };
}

// 批量导入：items 为 [{name, jobNo, dept}]，由前端解析文本后传入
//（解析在前端做，因为列序不固定，要让管理员粘贴后立刻看到「识别到 N 人」的预览）。
// 工号是必填项，缺工号的行不会导入；电话属于个人资料，由各人认领后自己填。
async function addBatch(event) {
  const items = event.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, message: '没有可导入的内容' };
  }
  if (items.length > MAX_BATCH) {
    return { success: false, message: '单次最多导入 ' + MAX_BATCH + ' 人' };
  }

  // 先把已有名册读出来做去重，避免逐条查库
  const existing = await fetchAll({});
  const seen = {};
  const seenJobNo = {};
  existing.forEach((d) => {
    seen[d.name + '|' + d.dept] = true;
    if (d.jobNo) seenJobNo[d.jobNo] = d.name || '';
  });

  let added = 0;
  const skipped = [];
  const invalid = [];
  const dupJobNo = [];
  const noJobNo = [];

  for (const raw of items) {
    const name = String((raw && raw.name) || '').trim().slice(0, 20);
    const dept = String((raw && raw.dept) || '').trim();
    if (!name) continue;

    const jobNo = normalizeJobNo(raw && raw.jobNo);
    if (!jobNo) {
      noJobNo.push(name);
      continue;
    }
    if (DEPTS.indexOf(dept) < 0) {
      invalid.push(name + '(' + (dept || '科室为空') + ')');
      continue;
    }
    const key = name + '|' + dept;
    if (seen[key]) {
      skipped.push(name);
      continue;
    }
    // 工号在部门内唯一。同一批里重复也算：seenJobNo 是边导入边写的，
    // 它同时覆盖「库里已有」和「本批前面刚导入」两种情况。
    if (seenJobNo[jobNo]) {
      dupJobNo.push(name + ' ' + jobNo);
      continue;
    }

    seen[key] = true;
    seenJobNo[jobNo] = name;
    await db.collection('staff').add({
      data: {
        name,
        dept,
        jobNo,
        // 电话留空，由本人认领后自行填写
        phone: '',
        openid: '',
        isAdmin: false,
        active: true,
        sort: Date.now() + added,
        createdAt: db.serverDate(),
      },
    });
    added++;
  }

  return {
    success: true,
    added,
    skippedCount: skipped.length,
    invalidCount: invalid.length,
    invalid: invalid.slice(0, 10),
    dupJobNoCount: dupJobNo.length,
    noJobNoCount: noJobNo.length,
  };
}

async function updateOne(event) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少人员 ID' };
  const patch = {};
  if (event.name) patch.name = String(event.name).trim().slice(0, 20);
  if (event.dept) {
    if (DEPTS.indexOf(event.dept) < 0) return { success: false, message: '科室不正确' };
    patch.dept = event.dept;
  }
  // 工号可以由管理员改 / 补：存量名册是「姓名 + 科室」两列导进来的，没有工号，
  // 而认领时工号是必填且要核对，所以必须给管理员留一条逐人补填的路径。
  // 同样不允许改成空——那等于把这个人重新锁在门外。
  if (typeof event.jobNo === 'string') {
    const jobNo = normalizeJobNo(event.jobNo);
    if (!jobNo) return { success: false, message: '工号格式不正确（2-20 位字母或数字）' };
    const dup = await db
      .collection('staff')
      .where({ jobNo, _id: _.neq(id) })
      .limit(1)
      .get();
    if (dup.data.length > 0) {
      return { success: false, message: '该工号已被「' + (dup.data[0].name || '') + '」占用' };
    }
    patch.jobNo = jobNo;
  }
  // 电话不在这里改：它是个人资料，只能由本人在「我的 → 编辑我的资料」里维护
  if (typeof event.active === 'boolean') patch.active = event.active;
  if (Object.keys(patch).length === 0) return { success: false, message: '没有需要修改的内容' };
  await db.collection('staff').doc(id).update({ data: patch });
  return { success: true };
}

async function removeOne(event, openid) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少人员 ID' };
  const doc = await db.collection('staff').doc(id).get();
  if (!doc.data) return { success: false, message: '该人员不存在' };
  if (doc.data.openid && doc.data.openid === openid) {
    return { success: false, message: '不能移除自己' };
  }
  await db.collection('staff').doc(id).remove();
  return { success: true };
}

// 授予或取消管理员。不允许取消自己的管理员身份，避免把自己锁在门外。
async function setAdmin(event, openid) {
  const id = event.id;
  if (!id) return { success: false, message: '缺少人员 ID' };
  const doc = await db.collection('staff').doc(id).get();
  if (!doc.data) return { success: false, message: '该人员不存在' };
  if (doc.data.openid === openid && event.isAdmin === false) {
    return { success: false, message: '不能取消自己的管理员身份' };
  }
  await db.collection('staff').doc(id).update({ data: { isAdmin: !!event.isAdmin } });
  return { success: true };
}

// 一次性修正存量数据：把「除操作者本人以外」的管理员标记全部取消。
//
// 背景：认领流程里「第一个使用者自动成为管理员」的判断曾经写成
// `claimedAt: db.command.exists(true)`，用字段存在性推断不可靠，导致**每个认领的人都**
// 拿到管理员标记。判断已改用 openid 口径（见 login 云函数），但已经写进库里的错误标记需要清理。
// 保留操作者本人，避免把自己也降级后进不去管理页。
async function fixAdmins(openid) {
  const admins = await fetchAll({ isAdmin: true });
  const names = [];
  for (const d of admins) {
    if (d.openid && d.openid === openid) continue;
    await db.collection('staff').doc(d._id).update({ data: { isAdmin: false } });
    names.push(d.name || '');
  }
  return { success: true, removed: names.length, names: names.slice(0, 20) };
}

// 清空尚未被认领的名册项，用于导入出错后重来。已认领的人不受影响。
async function clearUnclaimed() {
  const list = await fetchAll(unclaimedWhere(null));
  for (const d of list) {
    await db.collection('staff').doc(d._id).remove();
  }
  return { success: true, removed: list.length };
}
