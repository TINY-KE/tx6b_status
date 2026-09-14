const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 科室列表的唯一来源，改动这里即可。
// 注意：staff 云函数里有一份同样的常量用于校验，两处需保持一致。
const DEPTS = ['1室', '2室', '3室', '4室', '部办'];

// ===== 集合自动初始化 =====
// 云开发不会为云函数自动建集合，手工去控制台创建是部署时最容易漏的一步，
// 漏了会报 "database collection not exists"。这里在首次调用时补上，部署完即可用。
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
      // 建集合失败不阻塞主流程，让后续的真实错误暴露出来
      collectionsReady = null;
      return false;
    });
  }
  return collectionsReady;
}

// 把 staff 文档裁剪成前端需要的最小字段
function toMe(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    name: doc.name,
    dept: doc.dept,
    phone: doc.phone || '',
    openid: doc.openid,
    isAdmin: !!doc.isAdmin,
  };
}

// 电话号码规范化（与 staff 云函数同一规则）：去掉空格、横线、括号，保留可选前导 +。
// 选填——留空合法；填了就必须是 4-20 位数字。返回 null 表示格式非法。
function normalizePhone(raw) {
  const t = String(raw || '').replace(/[\s\-()（）]/g, '');
  if (!t) return '';
  return /^\+?\d{4,20}$/.test(t) ? t : null;
}

exports.main = async (event) => {
  await ensureCollections();

  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, message: '未获取到微信身份' };
  }

  const action = event && event.action;

  if (action === 'claim') {
    return claim(event, OPENID);
  }
  if (action === 'bootstrap') {
    return bootstrap(event, OPENID);
  }
  if (action === 'update') {
    return updateProfile(event, OPENID);
  }

  // 默认：查询身份状态
  const res = await db.collection('staff').where({ openid: OPENID }).limit(1).get();
  const me = res.data[0] || null;
  const total = await db.collection('staff').count();
  return {
    success: true,
    openid: OPENID,
    me: toMe(me),
    claimed: !!me,
    // 名册为空时前端要给出「创建首个身份」的入口，
    // 否则第一个人无从认领，也就没人能当管理员去导入名册，形成死锁。
    rosterEmpty: total.total === 0,
    deptOptions: DEPTS,
  };
};

// 冷启动：名册完全为空时，允许第一个进来的人建档并直接成为管理员。
// 只为打破「没人认领 → 没人当管理员 → 无法导入名册」的死锁，
// 一旦名册有任何内容，这个入口就自动关闭。
async function bootstrap(event, openid) {
  const count = await db.collection('staff').count();
  if (count.total > 0) {
    return { success: false, message: '名册已存在，请直接认领自己的名字' };
  }

  const name = String(event.name || '').trim().slice(0, 20);
  const dept = String(event.dept || '').trim();
  if (!name) return { success: false, message: '请填写姓名' };
  if (DEPTS.indexOf(dept) < 0) return { success: false, message: '请选择科室' };
  // 电话在创建身份时是必填的（与认领流程保持一致）
  const phone = normalizePhone(event.phone);
  if (phone === null) return { success: false, message: '电话号码格式不正确' };
  if (!phone) return { success: false, message: '请填写电话号码' };

  const addRes = await db.collection('staff').add({
    data: {
      name,
      dept,
      phone,
      openid,
      isAdmin: true,
      active: true,
      sort: Date.now(),
      createdAt: db.serverDate(),
      claimedAt: db.serverDate(),
    },
  });

  const doc = await db.collection('staff').doc(addRes._id).get();
  return { success: true, me: toMe(doc.data), becameAdmin: true };
}

// 认领名册里的一个身份：把自己的 openid 写到对应人员记录上。
// 第一个认领的人自动成为管理员，省去手工配置。
async function claim(event, openid) {
  const staffId = event.staffId;
  if (!staffId) {
    return { success: false, message: '请选择你的姓名' };
  }

  // 一个人只能认领一个身份
  const mine = await db.collection('staff').where({ openid }).limit(1).get();
  if (mine.data.length > 0) {
    return { success: false, message: '你已认领过身份，如需更换请联系管理员' };
  }

  let target;
  try {
    target = await db.collection('staff').doc(staffId).get();
  } catch (e) {
    return { success: false, message: '该人员不存在' };
  }
  if (!target.data) {
    return { success: false, message: '该人员不存在' };
  }
  if (target.data.openid) {
    return { success: false, message: '该身份已被认领' };
  }

  // 电话在认领时是必填的
  const phone = normalizePhone(event.phone);
  if (phone === null) return { success: false, message: '电话号码格式不正确' };
  if (!phone) return { success: false, message: '请填写电话号码' };

  // 「第一个使用者自动成为管理员」的判断。
  //
  // ✗ 别写成 claimedAt: db.command.exists(true)：用「字段是否存在」推断「有没有人认领过」
  //   不可靠，实测会每次都判成"第一个"，结果是**每个认领的人都变成管理员**。
  // ✓ 用项目统一的「已认领」口径（openid 非空），再加一道保险：
  //   只要已经存在任何管理员，就绝不再自动授予。
  const claimedCount = await db.collection('staff').where({ openid: db.command.neq('') }).count();
  const adminCount = await db.collection('staff').where({ isAdmin: true }).count();
  const isFirst = claimedCount.total === 0 && adminCount.total === 0;
  console.log('[claim] claimed=' + claimedCount.total + ' admin=' + adminCount.total + ' isFirst=' + isFirst);

  const patch = {
    openid,
    claimedAt: db.serverDate(),
    phone: phone,
  };
  if (isFirst) patch.isAdmin = true;

  await db.collection('staff').doc(staffId).update({ data: patch });

  const after = await db.collection('staff').doc(staffId).get();
  return { success: true, me: toMe(after.data), becameAdmin: isFirst };
}

// 修改自己的姓名、科室与电话（管理员可改任意人，见 staff 云函数）
async function updateProfile(event, openid) {
  const res = await db.collection('staff').where({ openid }).limit(1).get();
  if (res.data.length === 0) {
    return { success: false, message: '请先认领身份' };
  }
  const patch = {};
  if (event.name) patch.name = String(event.name).trim().slice(0, 20);
  if (event.dept && DEPTS.indexOf(event.dept) >= 0) patch.dept = event.dept;
  // 用 typeof 判断「传没传这个字段」（真值判断会把空串当成没传）。
  // 电话是必填项，所以传了就不允许为空——这样"必填"才是贯彻到底的。
  if (typeof event.phone === 'string') {
    const phone = normalizePhone(event.phone);
    if (phone === null) return { success: false, message: '电话号码格式不正确' };
    if (!phone) return { success: false, message: '请填写电话号码' };
    patch.phone = phone;
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, message: '没有需要修改的内容' };
  }
  await db.collection('staff').doc(res.data[0]._id).update({ data: patch });
  const after = await db.collection('staff').doc(res.data[0]._id).get();
  return { success: true, me: toMe(after.data) };
}
