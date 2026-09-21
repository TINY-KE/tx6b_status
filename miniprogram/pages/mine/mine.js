const rosterUtil = require('../../utils/roster.js');

Page({
  data: {
    loading: true,
    joined: false,
    me: null,
    initial: '',
    isAdmin: false,

    // 名册为空时的「创建首个身份」入口
    rosterEmpty: false,
    setupMode: false,
    setupName: '',
    setupJobNo: '',
    setupPhone: '',
    setupDeptIndex: 0,
    setupDeptText: '',

    // 认领流程
    claimMode: false,
    keyword: '',
    claimJobNo: '',
    claimPhone: '',
    claimList: [],
    claimLoading: false,
    claimEmpty: false,
    emptyText: '',

    // 资料编辑
    editing: false,
    editName: '',
    editPhone: '',
    editJobNoText: '',
    deptOptions: [],
    deptIndex: 0,
    editDept: '',
    saving: false,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const app = getApp();
    app.ensureReady().then((res) => {
      const me = app.globalData.me;
      const depts = (res && res.deptOptions) || [];
      const rosterEmpty = !!app.globalData.rosterEmpty;
      this.setData({
        loading: false,
        joined: !!me,
        me,
        initial: me && me.name ? me.name.slice(0, 1) : '',
        isAdmin: app.globalData.isAdmin,
        deptOptions: depts,
        rosterEmpty,
      });

      if (me) return;
      // 名册为空 → 引导创建首个身份（否则没人能当管理员去导名册）
      // 名册有内容 → 引导从名册中认领
      if (rosterEmpty) {
        if (!this.data.setupMode && !this.data.claimMode) {
          this.setData({ setupMode: true, setupDeptText: depts[0] || '' });
        }
      } else if (!this.data.claimMode) {
        this.setData({ claimMode: true });
        this.loadClaimable('');
      }
    });
  },

  onSetupName(e) {
    this.setData({ setupName: e.detail.value });
  },

  onSetupJobNo(e) {
    this.setData({ setupJobNo: e.detail.value });
  },

  onSetupPhone(e) {
    this.setData({ setupPhone: e.detail.value });
  },

  onSetupDept(e) {
    const idx = Number(e.detail.value);
    this.setData({
      setupDeptIndex: idx,
      setupDeptText: this.data.deptOptions[idx] || '',
    });
  },

  // 建第一个身份并自动成为管理员
  async bootstrapIdentity() {
    const name = String(this.data.setupName || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    const dept = this.data.deptOptions[this.data.setupDeptIndex];
    if (!dept) {
      wx.showToast({ title: '请选择科室', icon: 'none' });
      return;
    }
    const phone = String(this.data.setupPhone || '').trim();
    if (!phone) {
      wx.showToast({ title: '请填写电话号码', icon: 'none' });
      return;
    }
    // 工号必填：先在本地按与云函数同一套规则归一化，格式不对就不用麻烦服务端了
    const jobNo = rosterUtil.normalizeJobNo(this.data.setupJobNo);
    if (!jobNo) {
      wx.showToast({ title: '请填写工号（2-20 位字母或数字）', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '创建中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'login',
        data: { action: 'bootstrap', name, dept, phone, jobNo },
      });
      if (result && result.success) {
        await getApp().refresh();
        const me = getApp().globalData.me;
        this.setData({
          joined: true,
          me,
          initial: me && me.name ? me.name.slice(0, 1) : '',
          isAdmin: true,
          setupMode: false,
          rosterEmpty: false,
        });
        wx.showToast({ title: '已创建，你是管理员', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.message) || '创建失败', icon: 'none' });
      }
    } catch (e) {
      console.error('创建首个身份失败', e);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  openClaim() {
    this.setData({ claimMode: true, keyword: '' });
    this.loadClaimable('');
  },

  cancelClaim() {
    this.setData({ claimMode: false, keyword: '', claimList: [] });
  },

  onKeywordInput(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    clearTimeout(this._t);
    this._t = setTimeout(() => this.loadClaimable(kw), 250);
  },

  onClaimJobNo(e) {
    this.setData({ claimJobNo: e.detail.value });
  },

  onClaimPhone(e) {
    this.setData({ claimPhone: e.detail.value });
  },

  async loadClaimable(keyword) {
    this.setData({ claimLoading: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'staff',
        data: { action: 'claimable' },
      });
      if (!result || !result.success) {
        this.setData({ claimLoading: false, claimEmpty: true });
        return;
      }
      const kw = String(keyword || '').trim();
      let list = result.list || [];
      if (kw) {
        list = list.filter((x) => (x.name || '').indexOf(kw) >= 0 || (x.dept || '').indexOf(kw) >= 0);
      }
      // 区分两种「空」：名册还没导入，和搜索没匹配上。
      // 这两种情况对用户来说要做的事完全不同，必须分开提示。
      let emptyText = '';
      if (list.length === 0) {
        const all = result.list || [];
        emptyText = all.length === 0
          ? '部门名册还是空的，请联系管理员先导入名册'
          : '没有找到匹配的人，换个关键词试试';
      }
      this.setData({
        claimLoading: false,
        claimEmpty: list.length === 0,
        emptyText,
        claimList: list.map((x) => ({ _id: x._id, name: x.name, dept: x.dept })),
      });
    } catch (e) {
      console.error('加载名册失败', e);
      this.setData({ claimLoading: false, claimEmpty: true });
    }
  },

  async doClaim(e) {
    const item = e.currentTarget.dataset;
    // 工号 + 电话都是必填项。**先校验再弹确认框**——否则用户点了「是我」
    // 才被告知没填，白跑一趟。
    //
    // 工号在这里还只是"填了没有"，对不对由云函数拿它和名册记录比对。
    // 不在前端比对：认领列表接口不下发工号（下发了就等于把答案印在题面上）。
    const jobNo = rosterUtil.normalizeJobNo(this.data.claimJobNo);
    if (!jobNo) {
      wx.showToast({ title: '请先填写工号（2-20 位字母或数字）', icon: 'none' });
      return;
    }
    const phone = String(this.data.claimPhone || '').trim();
    if (!phone) {
      wx.showToast({ title: '请先填写电话号码', icon: 'none' });
      return;
    }
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '确认身份',
        content: '你是「' + item.dept + ' ' + item.name + '」吗？认领后如需更改请联系管理员。',
        confirmText: '是我',
        cancelText: '再想想',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    wx.showLoading({ title: '认领中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'login',
        data: {
          action: 'claim',
          staffId: item.id,
          jobNo,
          phone,
        },
      });
      if (result && result.success) {
        await getApp().refresh();
        const me = getApp().globalData.me;
        this.setData({
          joined: true,
          me,
          initial: me && me.name ? me.name.slice(0, 1) : '',
          isAdmin: getApp().globalData.isAdmin,
          claimMode: false,
          claimList: [],
          claimJobNo: '',
          claimPhone: '',
        });
        wx.showToast({
          title: result.becameAdmin ? '已认领，你成为管理员' : '认领成功',
          icon: 'success',
        });
      } else {
        wx.showToast({ title: (result && result.message) || '认领失败', icon: 'none' });
      }
    } catch (err) {
      console.error('认领失败', err);
      wx.showToast({ title: '认领失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  startEdit() {
    const me = this.data.me || {};
    const depts = this.data.deptOptions;
    const idx = Math.max(0, depts.indexOf(me.dept));
    this.setData({
      editing: true,
      editName: me.name || '',
      editPhone: me.phone || '',
      // 工号只读展示。兜底文案在 JS 里算好——WXML 的 {{}} 里不写中文字面量。
      // 走到「未登记」说明这是工号上线前建的老记录，主人得去找管理员补。
      editJobNoText: me.jobNo || '未登记',
      editDept: depts[idx] || '',
      deptIndex: idx,
    });
  },

  cancelEdit() {
    this.setData({ editing: false });
  },

  onEditName(e) {
    this.setData({ editName: e.detail.value });
  },

  onEditPhone(e) {
    this.setData({ editPhone: e.detail.value });
  },

  onDeptChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ deptIndex: idx, editDept: this.data.deptOptions[idx] });
  },

  async saveEdit() {
    if (this.data.saving) return;
    const name = String(this.data.editName || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    // 电话是必填项，编辑时也不允许留空
    const phone = String(this.data.editPhone || '').trim();
    if (!phone) {
      wx.showToast({ title: '请填写电话号码', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'login',
        data: {
          action: 'update',
          name,
          dept: this.data.editDept,
          phone,
        },
      });
      if (result && result.success) {
        await getApp().refresh();
        const me = getApp().globalData.me;
        this.setData({
          me,
          initial: me && me.name ? me.name.slice(0, 1) : '',
          editing: false,
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.message) || '保存失败', icon: 'none' });
      }
    } catch (e) {
      console.error('保存资料失败', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  goManage() {
    wx.navigateTo({ url: '/pages/manage/manage' });
  },

  goBoard() {
    wx.switchTab({ url: '/pages/board/board' });
  },
});
