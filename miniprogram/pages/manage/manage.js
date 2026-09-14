// 科室归一化：容忍「一室」「1 室」「办公室」等常见写法
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

// 解析粘贴进来的名册文本。每行一个人，支持：
//   Excel 复制的制表符分隔、中英文逗号、空格
// 只取姓名和科室两列。多写的内容（比如从别的表里带过来的电话列）会被忽略——
// 电话是个人资料，由各人认领后自己填，不由管理员导入。
function parseRoster(text) {
  const items = [];
  const bad = [];
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
    items.push({ name: parts[0], dept: normalizeDept(parts[1]) });
  });
  return { items, bad };
}

Page({
  data: {
    tab: 'list',
    isAdmin: false,

    // 名册
    deptTabs: [],
    deptFilter: '',
    keyword: '',
    list: [],
    filtered: [],
    loading: false,

    // 新增单人
    newName: '',
    newDeptIndex: 0,
    newDeptText: '',
    deptOptions: [],

    // 批量导入
    rosterText: '',
    previewCount: 0,
    previewText: '',

    importing: false,
  },

  onLoad() {
    const app = getApp();
    app.ensureReady().then((res) => {
      const depts = (res && res.deptOptions) || ['1室', '2室', '3室', '4室', '部办'];
      this.setData({
        isAdmin: app.globalData.isAdmin,
        deptOptions: depts,
        newDeptText: depts[0] || '',
        deptTabs: [{ value: '', label: '全部' }].concat(
          depts.map((d) => ({ value: d, label: d }))
        ),
      });
      this.loadList();
    });
  },

  onTabChange(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'list' },
      });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.message) || '加载失败', icon: 'none' });
        this.setData({ loading: false });
        return;
      }
      const list = (result.list || []).map((x) => ({
        _id: x._id,
        name: x.name,
        dept: x.dept,
        phone: x.phone || '',
        claimed: x.claimed,
        isAdmin: x.isAdmin,
        stateText: x.claimed ? '已认领' : '未认领',
        stateClass: x.claimed ? 'st-ok' : 'st-wait',
        // 在 JS 里算好文案，避免在 WXML 表达式里写中文
        adminActionText: x.isAdmin ? '取消管理员' : '设为管理员',
      }));
      this.setData({ list, loading: false });
      this.applyFilter();
    } catch (e) {
      console.error('加载名册失败', e);
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const { list, deptFilter, keyword } = this.data;
    const kw = String(keyword || '').trim();
    const filtered = list.filter((x) => {
      if (deptFilter && x.dept !== deptFilter) return false;
      if (kw && (x.name || '').indexOf(kw) < 0) return false;
      return true;
    });
    this.setData({ filtered });
  },

  onDeptFilter(e) {
    this.setData({ deptFilter: e.currentTarget.dataset.dept || '' });
    this.applyFilter();
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  onNewName(e) {
    this.setData({ newName: e.detail.value });
  },

  onNewDept(e) {
    const idx = Number(e.detail.value);
    this.setData({
      newDeptIndex: idx,
      newDeptText: this.data.deptOptions[idx] || '',
    });
  },

  async addOne() {
    const name = String(this.data.newName || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    const dept = this.data.deptOptions[this.data.newDeptIndex];
    wx.showLoading({ title: '添加中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'add', name, dept },
      });
      if (result && result.success) {
        wx.showToast({ title: '已添加', icon: 'success' });
        this.setData({ newName: '' });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '添加失败', icon: 'none' });
      }
    } catch (e) {
      console.error('添加失败', e);
      wx.showToast({ title: '添加失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async removeOne(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '移除人员',
        content: '确定把「' + name + '」从名册中移除吗？',
        confirmText: '移除',
        confirmColor: '#e34d59',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    wx.showLoading({ title: '处理中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'remove', id },
      });
      if (result && result.success) {
        wx.showToast({ title: '已移除', icon: 'success' });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '移除失败', icon: 'none' });
      }
    } catch (err) {
      console.error('移除失败', err);
      wx.showToast({ title: '移除失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async toggleAdmin(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const isAdmin = e.currentTarget.dataset.admin;
    const next = !isAdmin;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: next ? '设为管理员' : '取消管理员',
        content: next
          ? '将「' + name + '」设为管理员？管理员可以管理名册和查看全部人员。'
          : '取消「' + name + '」的管理员身份？',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    wx.showLoading({ title: '处理中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'setAdmin', id, isAdmin: next },
      });
      if (result && result.success) {
        wx.showToast({ title: '已更新', icon: 'success' });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      console.error('设置管理员失败', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onRosterInput(e) {
    const text = e.detail.value;
    const { items, bad } = parseRoster(text);
    let previewText = '';
    if (items.length) {
      previewText = '识别到 ' + items.length + ' 人';
      if (bad.length) previewText = previewText + '，另有 ' + bad.length + ' 行无法识别';
    } else if (bad.length) {
      previewText = '没有识别到有效内容，请检查格式';
    }
    this.setData({ rosterText: text, previewCount: items.length, previewText });
  },

  async doImport() {
    if (this.data.importing) return;
    const { items, bad } = parseRoster(this.data.rosterText);
    if (items.length === 0) {
      wx.showToast({ title: '没有可导入的内容', icon: 'none' });
      return;
    }

    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确认导入',
        content: '将导入 ' + items.length + ' 人' + (bad.length ? '，忽略 ' + bad.length + ' 行' : '') + '。同名同科室的人会自动跳过。',
        confirmText: '导入',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    this.setData({ importing: true });
    wx.showLoading({ title: '导入中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'addBatch', items },
      });
      if (result && result.success) {
        let msg = '成功导入 ' + result.added + ' 人';
        if (result.skippedCount) msg = msg + '，跳过重复 ' + result.skippedCount + ' 人';
        if (result.invalidCount) msg = msg + '，科室不识别 ' + result.invalidCount + ' 人';
        wx.showModal({
          title: '导入完成',
          content: msg + (result.invalid && result.invalid.length ? '\n\n科室不识别：' + result.invalid.join('、') : ''),
          showCancel: false,
          confirmText: '好的',
        });
        this.setData({ rosterText: '', previewCount: 0, previewText: '' });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '导入失败', icon: 'none' });
      }
    } catch (e) {
      console.error('导入失败', e);
      wx.showToast({ title: '导入失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ importing: false });
    }
  },

  async clearUnclaimed() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '清空未认领名册',
        content: '将删除所有还没人认领的人员记录，已认领的人不受影响。确定继续吗？',
        confirmText: '清空',
        confirmColor: '#e34d59',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    wx.showLoading({ title: '清理中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'clearUnclaimed' },
      });
      if (result && result.success) {
        wx.showToast({ title: '已清理 ' + result.removed + ' 条', icon: 'none' });
        this.loadList();
      }
    } catch (e) {
      console.error('清理失败', e);
      wx.showToast({ title: '清理失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
});
