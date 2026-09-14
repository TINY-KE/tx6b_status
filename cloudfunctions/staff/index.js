const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 与 login 云函数保持一致
const DEPTS = ['1室', '2室', '3室', '4室', '部办'];
const PAGE_SIZE = 100;
const PAGE_GUARD = 30;
const MAX_BATCH = 300;

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
    // 只回传认领必需字段
    list: list.map((d) => ({ _id: d._id, name: d.name, dept: d.dept })),
  };
}

async function adminList(event) {
  const where = {};
  if (event.dept) where.dept = event.dept;
  let list = await fetchAll(where, 'sort');
  if (event.keyword) {
    const kw = String(event.keyword).trim();
    list = list.filter((d) => (d.name || '').indexOf(kw) >= 0 || (d.dept || '').indexOf(kw) >= 0);
  }
  return { success: true, list: list.map(shape), deptOptions: DEPTS };
}

async function addOne(event) {
  const name = String(event.name || '').trim().slice(0, 20);
  const dept = String(event.dept || '').trim();
  if (!name) return { success: false, message: '请填写姓名' };
  if (DEPTS.indexOf(dept) < 0) return { success: false, message: '科室不正确' };

  const exist = await db.collection('staff').where({ name, dept }).limit(1).get();
  if (exist.data.length > 0) return { success: false, message: '该人员已存在' };

  await db.collection('staff').add({
    data: {
      name,
      dept,
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

// 批量导入：items 为 [{name, dept}]，由前端解析文本后传入。
// 只导入姓名和科室——电话属于个人资料，由各人认领后自己填（见 login 云函数）。
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
  existing.forEach((d) => {
    seen[d.name + '|' + d.dept] = true;
  });

  let added = 0;
  const skipped = [];
  const invalid = [];

  for (const raw of items) {
    const name = String((raw && raw.name) || '').trim().slice(0, 20);
    const dept = String((raw && raw.dept) || '').trim();
    if (!name) continue;
    if (DEPTS.indexOf(dept) < 0) {
      invalid.push(name + '(' + (dept || '科室为空') + ')');
      continue;
    }
    const key = name + '|' + dept;
    if (seen[key]) {
      skipped.push(name);
      continue;
    }
    seen[key] = true;
    await db.collection('staff').add({
      data: {
        name,
        dept,
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

// 清空尚未被认领的名册项，用于导入出错后重来。已认领的人不受影响。
async function clearUnclaimed() {
  const list = await fetchAll(unclaimedWhere(null));
  for (const d of list) {
    await db.collection('staff').doc(d._id).remove();
  }
  return { success: true, removed: list.length };
}
