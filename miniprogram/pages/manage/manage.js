// 名册文本的解析与工号规范化都在 utils/roster.js 里（纯函数，可单测）。
// 这里只负责把解析结果接进页面。
const rosterUtil = require('../../utils/roster.js');

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
    newJobNo: '',
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
      const list = (result.list || []).map((x) => {
        const jobNo = x.jobNo || '';
        return {
          _id: x._id,
          name: x.name,
          dept: x.dept,
          jobNo,
          phone: x.phone || '',
          claimed: x.claimed,
          isAdmin: x.isAdmin,
          stateText: x.claimed ? '已认领' : '未认领',
          stateClass: x.claimed ? 'st-ok' : 'st-wait',
          // 没工号的人：认领时必须填工号并与名册比对，所以他认领不了。
          // 这里显式标出来，管理员才知道要补——否则只会收到一句「认领不上」。
          // 文案在 JS 里算好，WXML 表达式里不写中文。
          needJobNo: !jobNo,
          jobNoText: jobNo || '缺工号',
          jobNoActionText: jobNo ? '改工号' : '补工号',
          // 在 JS 里算好文案，避免在 WXML 表达式里写中文
          adminActionText: x.isAdmin ? '取消管理员' : '设为管理员',
        };
      });
      this.setData({ list, loading: false });
      this.applyFilter();
    } catch (e) {
      console.error('加载名册失败', e);
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const { list, deptFilter, keyword } = this.data;
    const kw = String(keyword || '').trim().toLowerCase();
    const filtered = list.filter((x) => {
      if (deptFilter && x.dept !== deptFilter) return false;
      if (!kw) return true;
      // 姓名、科室、工号都能搜——工号是纯数字/字母，按大小写不敏感比对，
      // 免得名册里存的是 A100、管理员搜 a100 搜不到
      return (
        (x.name || '').indexOf(kw) >= 0 ||
        (x.dept || '').indexOf(kw) >= 0 ||
        (x.jobNo || '').toLowerCase().indexOf(kw) >= 0
      );
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

  onNewJobNo(e) {
    this.setData({ newJobNo: e.detail.value });
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
    // 工号是导入必填项：本人认领时要拿它和名册比对，缺了这个人就认领不了。
    // 先在本地按同一规则归一化，格式不对就不必麻烦云函数了。
    const jobNo = rosterUtil.normalizeJobNo(this.data.newJobNo);
    if (!jobNo) {
      wx.showToast({ title: '请填写工号（2-20 位字母或数字）', icon: 'none' });
      return;
    }
    const dept = this.data.deptOptions[this.data.newDeptIndex];
    wx.showLoading({ title: '添加中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'add', name, dept, jobNo },
      });
      if (result && result.success) {
        wx.showToast({ title: '已添加', icon: 'success' });
        this.setData({ newName: '', newJobNo: '' });
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
    // dataset 里的值会被转成字符串，直接 `!isAdmin` 两个方向都是 false
    //（!"true" 和 !"false" 都为 false），必须先显式比对。
    const isAdmin = String(e.currentTarget.dataset.admin) === 'true';
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

  // 一次性清理：把除自己以外的管理员标记全部取消。
  // 用于修复早期「第一个认领者」判断错误留下的存量数据。
  async fixAdmins() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '修正管理员标记',
        content: '将取消除你以外所有人的管理员标记，只保留你一个管理员。如果部门里还有其他管理员，修正后需要手动加回来。确定继续吗？',
        confirmText: '修正',
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
        data: { action: 'fixAdmins' },
      });
      if (result && result.success) {
        wx.showModal({
          title: '已修正',
          content: result.removed
            ? '已取消 ' + result.removed + ' 人的管理员标记，只保留你自己。'
            : '没有需要修正的记录。',
          showCancel: false,
          confirmText: '好的',
        });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '修正失败', icon: 'none' });
      }
    } catch (err) {
      console.error('修正管理员失败', err);
      wx.showToast({ title: '修正失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // 补 / 改某个人的工号。
  //
  // 为什么需要这个入口：工号是后加的需求，之前导进来的名册里没有这一列。
  // 而认领时工号是必填、且要与名册里的值比对，所以存量的人一律认领不上。
  // 有了「补工号」，管理员逐人补齐即可，不必「清空未认领名册」再重导一遍。
  // 用 wx.showModal 的 editable 输入框，省掉一整套自绘弹窗。
  async editJobNo(e) {
    const ds = e.currentTarget.dataset;
    const id = ds.id;
    const name = ds.name;
    const cur = ds.jobno || '';
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: cur ? '修改工号' : '补填工号',
        content: cur,
        editable: true,
        placeholderText: '请输入 ' + name + ' 的工号（2-20 位字母或数字）',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    const jobNo = rosterUtil.normalizeJobNo(res.content);
    if (!jobNo) {
      wx.showToast({ title: '工号格式不正确（2-20 位字母或数字）', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'update', id, jobNo },
      });
      if (result && result.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.loadList();
      } else {
        wx.showToast({ title: (result && result.message) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      console.error('保存工号失败', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onRosterInput(e) {
    const text = e.detail.value;
    const { items, bad, missing } = rosterUtil.parseRoster(text);
    let previewText = '';
    if (items.length) {
      previewText = '识别到 ' + items.length + ' 人';
      // 「缺工号」和「认不出格式」要分开报：
      // 前者是格式升级（旧的姓名+科室两列写法），补一列就能过；
      // 后者是分隔符都没用对，得看原文。
      if (missing.length) previewText += '，另有 ' + missing.length + ' 行缺少工号或工号格式不对（不会导入）';
      if (bad.length) previewText += '，' + bad.length + ' 行无法识别';
    } else if (missing.length || bad.length) {
      previewText = '没有识别到有效内容，每行需要「姓名 + 工号」，例如：张三,10086,1室';
    }
    this.setData({ rosterText: text, previewCount: items.length, previewText });
  },

  async doImport() {
    if (this.data.importing) return;
    const { items, bad, missing } = rosterUtil.parseRoster(this.data.rosterText);
    if (items.length === 0) {
      wx.showToast({ title: '没有可导入的内容', icon: 'none' });
      return;
    }

    let content = '将导入 ' + items.length + ' 人';
    if (missing.length) content += '，忽略 ' + missing.length + ' 行缺少工号或格式不对';
    if (bad.length) content += '，忽略 ' + bad.length + ' 行';
    content += '。同名同科室、或工号重复的人会自动跳过。';

    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确认导入',
        content,
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
        if (result.dupJobNoCount) msg = msg + '，工号已被占用 ' + result.dupJobNoCount + ' 人';
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
