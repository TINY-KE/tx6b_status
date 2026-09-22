// 名册文本的解析与工号规范化都在 utils/roster.js 里（纯函数，可单测）。
// 这里只负责把解析结果接进页面。
const rosterUtil = require('../../utils/roster.js');
const dateUtil = require('../../utils/date.js');
const noteUtil = require('../../utils/note.js');
const statusUtil = require('../../utils/status.js');

// 管理员代填时可选的去向：比员工端多一个「在岗」——
// 员工误报了请假（比如假条没批下来）时，得能把那些时段改回在岗。
const REC_TYPE_VALUES = ['office', 'meeting', 'trip', 'leave'];

// 记录状态文案。员工端只按状态置灰，管理端要看清「这条现在处于什么阶段」。
const REC_STATE_TEXT = { future: '未开始', active: '进行中', ended: '已结束' };

// 管理端记录列表的渲染结构。
// startDate/startTime/endDate/endTime 是云函数一起下发的结构化字段——
// 「修改」时要回填表单，绝不能去解析 dateText 那种给人看的字符串。
function shapeRecForAdmin(r) {
  return {
    _id: r._id,
    type: r.type,
    typeLabel: statusUtil.typeLabel(r.type),
    note: r.note || '',
    date: r.date,
    dateText: r.dateText,
    state: r.state,
    stateText: REC_STATE_TEXT[r.state] || '',
    stateClass: 'rs-' + (r.state || 'ended'),
    sameDay: r.sameDay,
    rangeText: r.rangeText,
    startDate: r.startDate || r.date,
    startTime: r.startTime || '08:30',
    endDate: r.endDate || r.date,
    endTime: r.endTime || '18:00',
  };
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
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
    newJobNo: '',
    newDeptIndex: 0,
    newDeptText: '',
    deptOptions: [],

    // 批量导入
    rosterText: '',
    previewCount: 0,
    previewText: '',

    importing: false,

    // 考勤导出
    expMonth: '',
    expMonthText: '',
    expSummary: '',
    expDates: [],
    exportBtnText: '生成考勤表',
    exporting: false,
    minMonth: '',
    maxMonth: '',
    // 生成好的本地文件（绝对路径，带 .xlsx 后缀）。转发按钮只在它非空时出现。
    readyPath: '',
    readyName: '',
    readyText: '',

    // 记录管理（管理员纠错）。员工端「只能填今天及以后 + 交叉拒绝 + 已结束不可改」
    // 那套规则必须配这个出口，否则漏填和填错都没有纠正途径。
    recDept: '',
    recKeyword: '',
    recStaff: [],
    recTargetId: '',
    recTargetName: '',
    recList: [],
    recLoading: false,
    // 代填 / 修改表单
    recFormOpen: false,
    recFormTitle: '',
    recReplaceId: '',
    recTypes: [],
    recType: 'meeting',
    recStartDate: '',
    recStartDateText: '',
    recStartTime: '08:30',
    recEndDate: '',
    recEndDateText: '',
    recEndTime: '18:00',
    recDateMin: '',
    recDateMax: '',
    recNote: '',
    recNoteTitle: '',
    recNotePlaceholder: '',
    recLeaveReasons: [],
    recForce: false,
    recForceText: '关闭',
    recSubmitting: false,
    recSubmitText: '保存',
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
      this.initExport();
      this.initRecords();
    });
  },

  // 导出默认落在这个月（只统计到今天）。可选范围：往前 12 个月 ~ 本月，
  // 不允许选未来——未来的考勤表没有意义，只会导出一张「全员在岗」的空表。
  initExport() {
    const today = dateUtil.today();
    const month = today.slice(0, 7);
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    this.setData({
      minMonth: y - 1 + '-' + pad2(m),
      maxMonth: month,
    });
    this.applyMonth(month);
  },

  // 换月份：就地重算「这个月要统计哪几天」。
  //
  // 为什么日期在小程序端算：工作日的判定依赖节假日表（utils/holidays.js），
  // 那份数据只存在于小程序端，云函数里再存一份就是第四个副本（必然漏更新）。
  // 与「区间视图的日期由前端算好再传给云函数」同一个思路。
  applyMonth(month) {
    const today = dateUtil.today();
    const isCurrent = month === today.slice(0, 7);
    // 只统计到今天：当月的未来工作日不进表；过去的月份取满月
    const dates = dateUtil.monthWorkdays(month, isCurrent ? today : month + '-31');
    const last = dates.length ? dates[dates.length - 1] : '';
    this.setData({
      expMonth: month,
      expMonthText: dateUtil.monthLabel(month),
      expDates: dates,
      expSummary: dates.length
        ? '该月工作日 ' + dates.length + ' 天，统计至 ' + dateUtil.dayDisplay(last)
        : '该月还没有可统计的工作日',
      exportBtnText: dates.length ? '生成考勤表' : '该月无工作日',
      // 换了月份，之前生成的文件就作废了——不清掉的话，
      // 会出现「选着 9 月、转发出去的却是 8 月那张表」。
      readyPath: '',
      readyName: '',
      readyText: '',
    });
  },

  onMonthChange(e) {
    const month = String(e.detail.value || '').slice(0, 7);
    if (month) this.applyMonth(month);
  },

  // 第一步：生成考勤表并下载到本地。
  //
  // ⚠️ 为什么生成和转发必须分成两次点击，而不是「点一下 → 生成完自动弹转发面板」：
  // wx.shareFileMessage 要求由**用户点击手势**直接触发，中间夹着
  // `await callFunction` + `await downloadFile` 两段异步，手势上下文就丢了，
  // 真机上会报 `shareFileMessage:fail can only be invoked by user TAP gesture`
  // ——表现就是一句无从下手的「转发未完成」。
  // 所以这里只负责把文件准备好，转发交给下一步的按钮（那个处理函数里
  // shareFileMessage 是同步第一句，手势完整）。
  async doExport() {
    if (this.data.exporting) return;
    const dates = this.data.expDates;
    if (!dates.length) {
      wx.showToast({ title: '该月没有可统计的工作日', icon: 'none' });
      return;
    }
    const month = this.data.expMonth;
    this.setData({ exporting: true, exportBtnText: '生成中…' });
    wx.showLoading({ title: '生成考勤表', mask: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'export', month, dates },
      });
      if (!result || !result.success) {
        wx.hideLoading();
        const msg = (result && result.message) || '生成失败';
        wx.showToast({
          title: msg === '未知操作' ? '请先部署 presence 云函数' : msg,
          icon: 'none',
        });
        return;
      }
      const local = await this.saveLocal(result.fileID, result.fileName || '考勤表-' + month + '.xlsx');
      wx.hideLoading();
      this.setData({
        readyPath: local.path,
        readyName: local.name,
        readyText: '已生成 ' + local.name + '，点下方按钮转发给需要的人。',
      });
    } catch (err) {
      wx.hideLoading();
      console.error('导出考勤表失败', err);
      // 超时是平台直接终止云函数、函数没机会 return，所以只能在这一层认出来。
      // 生成已经改成零依赖的手写 xlsx（毫秒级，见云函数里的「手写 xlsx」注释），
      // 原来最吃时间的 exceljs 冷启动已经没有了；这条兜底留给数据量特别大的极端情况。
      const raw = (err && (err.errMsg || err.message)) || '';
      const isTimeout = /timeout|timed out|-504003/i.test(raw);
      wx.showModal({
        title: isTimeout ? '云函数执行超时' : '导出失败',
        content: isTimeout
          ? '云函数执行超过了超时时间（默认 3 秒）。请到云开发控制台 → 云函数 → presence → 配置，把「超时时间」调成 60 秒后重试。'
          : '原因：' + (raw || '未知') + '\n\n详细报错可在云开发控制台 → 云函数 → presence → 日志里查看。',
        showCancel: false,
        confirmText: '知道了',
      });
    } finally {
      // 已经有文件时按钮变「重新生成」（并降级成描边样式），
      // 把视觉重心让给蓝色的「转发到微信」——两个实心蓝按钮叠着容易点错。
      this.setData({
        exporting: false,
        exportBtnText: this.data.expDates.length
          ? this.data.readyPath
            ? '重新生成'
            : '生成考勤表'
          : '该月无工作日',
      });
    }
  },

  // 把云存储里的 xlsx 下载下来，落到用户目录里一个**带 .xlsx 后缀**的固定路径。
  //
  // 为什么不直接用 cloud.downloadFile 的 tempFilePath 去转发：
  // 那个临时路径没有后缀，微信（以及收到文件的人）按后缀判类型，
  // 会得到一个「打不开」的无名文件。落到带后缀的路径上两个问题一起解决。
  saveLocal(fileID, fileName) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: (res) => {
          try {
            const fs = wx.getFileSystemManager();
            const path = wx.env.USER_DATA_PATH + '/' + fileName;
            // 同一月份重复导出会覆盖；换月份生成的新文件也用同一个目录，
            // 顺手清掉上一张，免得用户目录里越堆越多（上限 200MB）。
            try {
              const olds = fs.readdirSync(wx.env.USER_DATA_PATH) || [];
              olds.forEach((f) => {
                if (f.indexOf('考勤表-') === 0 && f !== fileName) {
                  try {
                    fs.unlinkSync(wx.env.USER_DATA_PATH + '/' + f);
                  } catch (e) {
                    // 删不掉就算了，不能因为清理失败让导出失败
                  }
                }
              });
            } catch (e) {
              // readdirSync 在个别机型上可能不可用，忽略
            }
            try {
              fs.unlinkSync(path);
            } catch (e) {
              // 目标不存在时会抛，属于正常情况
            }
            fs.copyFileSync(res.tempFilePath, path);
            resolve({ path, name: fileName });
          } catch (e) {
            console.error('保存考勤表到本地失败', e);
            reject(e);
          }
        },
        fail: (err) => {
          console.error('下载考勤表失败', err);
          reject(err);
        },
      });
    });
  },

  // 第二步：转发。处理函数里**不允许有任何 await / 异步前置**——
  // wx.shareFileMessage 必须落在这次点击的手势上下文里，否则真机上直接 fail。
  // 所以这里只读已存好的路径，然后同步调用。
  shareExport() {
    const filePath = this.data.readyPath;
    if (!filePath) {
      wx.showToast({ title: '请先生成考勤表', icon: 'none' });
      return;
    }
    const fileName = this.data.readyName;
    // 开发者工具和 PC 版微信都不支持这个接口，提前认出来给句人话，
    // 不然用户只会看到一句「转发未完成」。
    const info = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {};
    const platform = info.platform || '';
    if (platform !== 'android' && platform !== 'ios') {
      wx.showModal({
        title: '当前环境不支持转发',
        content:
          '微信转发面板只能在手机微信里调起（开发者工具、PC / Mac 版微信都不支持）。' +
          '请用手机扫码「真机预览」后再点这个按钮。文件已生成好，在手机上重新点一次即可。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.shareFileMessage({
      filePath,
      fileName,
      success: () => {
        wx.showToast({ title: '已发送', icon: 'success' });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        // 用户自己在转发面板点了取消，不算失败，不要弹错误提示
        if (/cancel/i.test(msg)) return;
        console.error('转发考勤表失败', err);
        // 以前这里只弹一句「转发未完成」，把真实原因吞了。
        // 现在把原始 errMsg 原样给出来——那句话是唯一能定位的线索。
        wx.showModal({
          title: '转发失败',
          content: '原因：' + (msg || '未知') + '\n\n可截图发给开发者定位。',
          showCancel: false,
          confirmText: '知道了',
        });
      },
    });
  },

  onTabChange(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    // 「记录管理」的人员列表复用名册数据，切过去时按它自己的筛选条件重算一次
    if (tab === 'records') this.recApplyFilter();
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
    // 名册变了，「记录管理」的人员列表也跟着变（两边共用同一份 list）
    this.recApplyFilter();
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

  // ===== 记录管理（管理员纠错）=====
  //
  // 员工端的规则是「只能填今天及以后 + 与已有记录交叉就拒绝 + 已结束的不能改」，
  // 这套规则把「事后改数据」的口子堵上了，代价是漏填、填错日期这类情况
  // 员工自己完全无解——所以必须配一个管理员出口，不是可选项。
  // 管理员的每一次改动都会写进 presence_logs。

  initRecords() {
    const t = dateUtil.today();
    this.setData({
      // 标签走 status.js 的 typeLabel，别在这儿另写一份中文
      recTypes: REC_TYPE_VALUES.map((v) => ({ value: v, label: statusUtil.typeLabel(v) })),
      recLeaveReasons: noteUtil.LEAVE_REASONS.map((x) => ({ text: x, active: '' })),
      recStartDate: t,
      recStartDateText: dateUtil.dayLabel(t),
      recEndDate: t,
      recEndDateText: dateUtil.dayLabel(t),
      // 管理员可以补过去：往前一年足够覆盖补漏；往后仍限 30 天，与员工端一致
      recDateMin: dateUtil.addDays(t, -365),
      recDateMax: dateUtil.addDays(t, 30),
    });
    this.syncRecNoteMeta();
  },

  // 记录管理的人员列表：只列已认领的人（记录挂在 openid 上，未认领的人不可能有记录）
  recApplyFilter() {
    const { list, recDept, recKeyword } = this.data;
    const kw = String(recKeyword || '').trim().toLowerCase();
    const recStaff = (list || []).filter((x) => {
      if (!x.claimed) return false;
      if (recDept && x.dept !== recDept) return false;
      if (!kw) return true;
      return (
        (x.name || '').indexOf(kw) >= 0 ||
        (x.dept || '').indexOf(kw) >= 0 ||
        (x.jobNo || '').toLowerCase().indexOf(kw) >= 0
      );
    });
    this.setData({ recStaff });
  },

  onRecDept(e) {
    this.setData({ recDept: e.currentTarget.dataset.dept || '' });
    this.recApplyFilter();
  },

  onRecKeyword(e) {
    this.setData({ recKeyword: e.detail.value });
    this.recApplyFilter();
  },

  async pickRecStaff(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id || id === this.data.recTargetId) return;
    // 换人要把表单收掉：表单是绑在「当前选中的人」上的，
    // 留着会让人以为还能把上一个没提交的内容存到新选的人名下
    this.setData({
      recTargetId: id,
      recTargetName: name || '',
      recList: [],
      recFormOpen: false,
      recReplaceId: '',
    });
    await this.loadRecRecords();
  },

  async loadRecRecords() {
    const staffId = this.data.recTargetId;
    if (!staffId) return;
    this.setData({ recLoading: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'adminRecords', staffId },
      });
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.message) || '加载失败', icon: 'none' });
        this.setData({ recLoading: false });
        return;
      }
      this.setData({
        recList: (result.list || []).map(shapeRecForAdmin),
        recLoading: false,
      });
    } catch (err) {
      console.error('加载员工记录失败', err);
      this.setData({ recLoading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 打开表单：带 index 是「改这条」，不带是「代填一条」
  openRecForm(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const idx = ds.index;

    if (idx === undefined || idx === '' || idx === null) {
      const t = dateUtil.today();
      this.setData({
        recFormOpen: true,
        recFormTitle: '代填一条记录',
        recReplaceId: '',
        recType: 'meeting',
        recStartDate: t,
        recStartDateText: dateUtil.dayLabel(t),
        recStartTime: '08:30',
        recEndDate: t,
        recEndDateText: dateUtil.dayLabel(t),
        recEndTime: '18:00',
        recNote: '',
        recLeaveReasons: noteUtil.LEAVE_REASONS.map((x) => ({ text: x, active: '' })),
        recForce: false,
        recForceText: '关闭',
        recSubmitText: '保存',
      });
      this.syncRecNoteMeta();
      return;
    }

    const item = this.data.recList[Number(idx)];
    if (!item) return;
    this.setData({
      recFormOpen: true,
      recFormTitle: '修改记录',
      recReplaceId: item._id,
      recType: item.type,
      recStartDate: item.startDate,
      recStartDateText: dateUtil.dayLabel(item.startDate),
      recStartTime: item.startTime,
      recEndDate: item.endDate,
      recEndDateText: dateUtil.dayLabel(item.endDate),
      recEndTime: item.endTime,
      recNote: item.note || '',
      recLeaveReasons: noteUtil.LEAVE_REASONS.map((x) => ({
        text: x,
        active: x === item.note ? 'on' : '',
      })),
      recForce: false,
      recForceText: '关闭',
      recSubmitText: '保存修改',
    });
    this.syncRecNoteMeta();
  },

  closeRecForm() {
    this.setData({ recFormOpen: false, recReplaceId: '' });
  },

  // 备注标题随类型走：出差=出差地（自由填写），请假=请假事由（只能点选）
  syncRecNoteMeta() {
    const meta = noteUtil.noteMeta(this.data.recType);
    this.setData({ recNoteTitle: meta.title, recNotePlaceholder: meta.placeholder });
  },

  onRecType(e) {
    // 换类型必须清空备注：出差地留着会变成非法的请假事由，
    // 事由留着会变成出差地，两边都不可信。
    this.setData({
      recType: e.currentTarget.dataset.value,
      recNote: '',
      recLeaveReasons: noteUtil.LEAVE_REASONS.map((x) => ({ text: x, active: '' })),
    });
    this.syncRecNoteMeta();
  },

  onRecStartDate(e) {
    const v = e.detail.value;
    this.setData({ recStartDate: v, recStartDateText: dateUtil.dayLabel(v) });
  },

  onRecStartTime(e) {
    this.setData({ recStartTime: e.detail.value });
  },

  onRecEndDate(e) {
    const v = e.detail.value;
    this.setData({ recEndDate: v, recEndDateText: dateUtil.dayLabel(v) });
  },

  onRecEndTime(e) {
    this.setData({ recEndTime: e.detail.value });
  },

  onRecNote(e) {
    this.setData({ recNote: e.detail.value });
  },

  // 点事由即选中，再点一次取消（与填写页同一套交互）
  onRecReason(e) {
    const text = e.currentTarget.dataset.text;
    const note = this.data.recNote === text ? '' : text;
    this.setData({
      recNote: note,
      recLeaveReasons: noteUtil.LEAVE_REASONS.map((x) => ({
        text: x,
        active: x === note ? 'on' : '',
      })),
    });
  },

  toggleRecForce() {
    const v = !this.data.recForce;
    this.setData({ recForce: v, recForceText: v ? '开启' : '关闭' });
  },

  async submitRecForm() {
    if (this.data.recSubmitting) return;
    const d = this.data;
    if (!d.recTargetId) {
      wx.showToast({ title: '请先选择人员', icon: 'none' });
      return;
    }

    const note = (d.recNote || '').trim();
    // 与员工端同一套口径（note.js 的 isValidNote）：出差非空、请假必须是 7 项之一。
    // 管理员也不放宽——否则导出的统计里会混进「年假」这种同义不同字。
    if (!noteUtil.isValidNote(d.recType, note)) {
      wx.showToast({
        title: d.recType === 'leave' ? '请选择请假事由' : '请填写出差地',
        icon: 'none',
      });
      return;
    }

    this.setData({ recSubmitting: true, recSubmitText: '保存中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: {
          action: 'adminSave',
          staffId: d.recTargetId,
          replaceId: d.recReplaceId || '',
          force: d.recForce,
          type: d.recType,
          startDate: d.recStartDate,
          startTime: d.recStartTime,
          endDate: d.recEndDate,
          endTime: d.recEndTime,
          note,
        },
      });
      if (result && result.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({
          recList: (result.list || []).map(shapeRecForAdmin),
          recFormOpen: false,
          recReplaceId: '',
        });
        return;
      }
      wx.showModal({
        title: '保存失败',
        content: (result && result.message) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (err) {
      console.error('保存记录失败', err);
      wx.showModal({
        title: '保存失败',
        content: (err && err.errMsg) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了',
      });
    } finally {
      this.setData({
        recSubmitting: false,
        recSubmitText: this.data.recReplaceId ? '保存修改' : '保存',
      });
    }
  },

  async recDelete(e) {
    const item = this.data.recList[Number(e.currentTarget.dataset.index)];
    if (!item) return;

    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除记录',
        content:
          '将删除 ' + (this.data.recTargetName || '该员工') + ' 的这条记录（' +
          item.dateText + '），并写入操作日志。确定吗？',
        confirmText: '删除',
        confirmColor: '#e34d59',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!res.confirm) return;

    wx.showLoading({ title: '删除中' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'adminRemove', id: item._id },
      });
      wx.hideLoading();
      if (result && result.success) {
        wx.showToast({ title: '已删除', icon: 'success' });
        this.setData({ recList: (result.list || []).map(shapeRecForAdmin) });
        return;
      }
      wx.showModal({
        title: '删除失败',
        content: (result && result.message) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (err) {
      wx.hideLoading();
      console.error('删除记录失败', err);
      wx.showModal({
        title: '删除失败',
        content: (err && err.errMsg) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },
});
