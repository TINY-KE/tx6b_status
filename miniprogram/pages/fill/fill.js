const dateUtil = require('../../utils/date');
const statusUtil = require('../../utils/status');
const noteUtil = require('../../utils/note');

// 起止日期跨度上限。出差最长按 30 天算，超过就拦下来，防止手滑选错月份。
const SPAN_LIMIT_DAYS = 30;
// 可选日期范围：允许补填过去 7 天，提前填未来 30 天
const PAST_DAYS = 7;
const FUTURE_DAYS = 30;
// 「连续 N 天」的天数范围：最少 2 天（1 天用「今天整天」即可），上限与跨度上限一致
const STREAK_MIN = 2;
const STREAK_MAX = SPAN_LIMIT_DAYS;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function minToText(m) {
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

// 把「日期 + 时刻」转成时间戳。
// 小程序跑在用户手机上，本地时区就是 +08:00，直接构造即可；
// 云函数那边运行在 UTC，写法完全不同，两处不要互相复制。
function tsOf(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00').getTime();
}

// 时刻往后推 1 小时，用于自动纠正「结束早于开始」
function bumpHour(timeStr) {
  const parts = timeStr.split(':');
  let m = Number(parts[0]) * 60 + Number(parts[1]) + 60;
  if (m > 23 * 60 + 59) m = 23 * 60 + 59;
  return minToText(m);
}

Page({
  data: {
    joined: false,
    meName: '',

    // 可填报的去向：京内出差 / 京外出差 / 请假。
    // 「在办公室」不在这里——它是默认状态，不填即视为在岗。
    types: [],
    type: '',

    // 统一的时间区间：开始 / 结束 各自由「日期 + 时刻」组成。
    // 出差跨天时两端日期不同即可，不需要另一套控件。
    startDate: '',
    startDateText: '',
    startTime: '08:30',
    endDate: '',
    endDateText: '',
    endTime: '18:00',
    dateMin: '',
    dateMax: '',
    spanText: '',
    spanWarn: false,

    // 快捷选项。点按钮会连同日期一起写好，所以「今天上午」这类标签
    // 必须写清「今天」——它们不以当前选中的日期为锚点。
    quickButtons: [],
    days: 2,
    streakRangeText: '',
    streakActive: '',
    daysMinusOff: '',
    daysPlusOff: '',

    // 备注栏：出差时标题是「出差地」、请假时是「请假事由」，且为必填。
    // 文案全部在 JS 里算好——WXML 的 {{}} 里不能出现中文字符串字面量。
    note: '',
    noteTitle: noteUtil.noteMeta('').title,
    notePlaceholder: noteUtil.noteMeta('').placeholder,
    noteHistory: [],
    myList: [],
    submitting: false,
    // 按钮文案在 JS 里算好，WXML 里不能写中文字符串字面量
    submitText: '保存',
  },

  onLoad() {
    const t = dateUtil.today();
    const types = statusUtil.pickableTypes().map((x) => ({
      value: x.value,
      label: x.label,
      active: '',
      colorClass: 'type-' + x.value,
    }));

    this.setData({
      types,
      quickButtons: [
        { kind: 'am', label: '今天上午', active: '' },
        { kind: 'pm', label: '今天下午', active: '' },
        { kind: 'day', label: '今天整天', active: '' },
      ],
      startDate: t,
      startDateText: dateUtil.dayLabel(t),
      startTime: '08:30',
      endDate: t,
      endDateText: dateUtil.dayLabel(t),
      endTime: '18:00',
      dateMin: dateUtil.addDays(t, -PAST_DAYS),
      dateMax: dateUtil.addDays(t, FUTURE_DAYS),
    });
    this.refreshSpan();
    this.updateStreakPreview();
    this.refreshQuickActive();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    const app = getApp();
    app.ensureReady().then(() => {
      const me = app.globalData.me;
      this.setData({ joined: !!me, meName: me ? me.name : '' });
      if (me) this.loadMine();
    });
  },

  refreshSpan() {
    const { startDate, endDate } = this.data;
    const diff = dateUtil.daysBetween(startDate, endDate);
    const over = diff > SPAN_LIMIT_DAYS;
    let spanText = '同一天内';
    if (diff === 1) spanText = '跨 2 天';
    else if (diff > 1) spanText = '跨 ' + (diff + 1) + ' 天';
    if (over) spanText = '跨 ' + (diff + 1) + ' 天，超过 ' + SPAN_LIMIT_DAYS + ' 天上限';
    this.setData({ spanText, spanWarn: over });
  },

  onPickType(e) {
    const value = e.currentTarget.dataset.value;
    const types = this.data.types.map((x) =>
      Object.assign({}, x, { active: x.value === value ? 'on' : '' })
    );
    // 备注标题跟着去向走：出差=出差地，请假=请假事由
    const meta = noteUtil.noteMeta(value);
    const patch = {
      types,
      type: value,
      noteTitle: meta.title,
      notePlaceholder: meta.placeholder,
    };

    // 京外/请假天然跨天：结束日期若还停在同一天，自动延到次日；
    // 京内出差一般是当天来回，切到它时把结束日期收回同一天。
    const isLong = value === 'trip' || value === 'leave';
    const { startDate, endDate, startTime, endTime } = this.data;

    if (isLong && endDate === startDate) {
      const next = dateUtil.addDays(startDate, 1);
      patch.endDate = next;
      patch.endDateText = dateUtil.dayLabel(next);
    } else if (!isLong && endDate !== startDate) {
      patch.endDate = startDate;
      patch.endDateText = dateUtil.dayLabel(startDate);
      // 收回同一天后，结束时刻可能反而早于开始时刻，顺延一小时
      if (tsOf(startDate, endTime) <= tsOf(startDate, startTime)) {
        patch.endTime = bumpHour(startTime);
      }
    }

    this.setData(patch);
    this.refreshSpan();
    this.refreshQuickActive();
    // 换了去向，历史备注也要换一组（出差地 ⇄ 请假事由 不混用）
    this.refreshNoteHistory();
  },

  onStartDateChange(e) {
    const startDate = e.detail.value;
    const patch = { startDate, startDateText: dateUtil.dayLabel(startDate) };
    // 结束日期不能早于开始日期，跟着挪
    if (this.data.endDate < startDate) {
      patch.endDate = startDate;
      patch.endDateText = dateUtil.dayLabel(startDate);
    }
    this.setData(patch);
    this.refreshSpan();
    this.refreshQuickActive();
  },

  onStartTimeChange(e) {
    const startTime = e.detail.value;
    const patch = { startTime };
    // 同一天内结束必须晚于开始，否则顺延一小时
    if (this.data.endDate === this.data.startDate) {
      if (tsOf(this.data.endDate, this.data.endTime) <= tsOf(this.data.startDate, startTime)) {
        patch.endTime = bumpHour(startTime);
      }
    }
    this.setData(patch);
    this.refreshQuickActive();
  },

  onEndDateChange(e) {
    const endDate = e.detail.value;
    const patch = { endDate, endDateText: dateUtil.dayLabel(endDate) };
    if (endDate < this.data.startDate) {
      patch.startDate = endDate;
      patch.startDateText = dateUtil.dayLabel(endDate);
    }
    this.setData(patch);
    this.refreshSpan();
    this.refreshQuickActive();
  },

  onEndTimeChange(e) {
    this.setData({ endTime: e.detail.value });
    this.refreshQuickActive();
  },

  onNoteChange(e) {
    this.setData({ note: e.detail.value });
  },

  // 快捷选项：一次写好「日期 + 时刻」四个字段。
  // 早先只改时刻不动日期，用户改过日期后点按钮毫无反应，会以为按钮坏了。
  // 这三个预设都以「今天」为锚点，所以标签里写明了「今天」。
  onQuickRange(e) {
    const kind = e.currentTarget.dataset.kind;
    const t = dateUtil.today();
    const patch = {
      startDate: t,
      startDateText: dateUtil.dayLabel(t),
      endDate: t,
      endDateText: dateUtil.dayLabel(t),
    };

    if (kind === 'am') {
      patch.startTime = '08:30';
      patch.endTime = '12:00';
    } else if (kind === 'pm') {
      patch.startTime = '12:00';
      patch.endTime = '18:00';
    } else {
      patch.startTime = '08:30';
      patch.endTime = '18:00';
    }

    this.setData(patch);
    this.refreshSpan();
    this.refreshQuickActive();
  },

  // 「连续 N 天」：今天 08:30 起，到第 N 天的 18:00
  applyStreak(days) {
    const n = Math.min(STREAK_MAX, Math.max(STREAK_MIN, days));
    const t = dateUtil.today();
    const end = dateUtil.addDays(t, n - 1);
    this.setData({
      days: n,
      startDate: t,
      startDateText: dateUtil.dayLabel(t),
      startTime: '08:30',
      endDate: end,
      endDateText: dateUtil.dayLabel(end),
      endTime: '18:00',
    });
    this.refreshSpan();
    this.updateStreakPreview();
    this.refreshQuickActive();
  },

  // 加减号：改天数并立即应用，所见即所得
  onDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    this.applyStreak(this.data.days + delta);
  },

  // 点整行（不是加减号）也应用一次，方便重复填同样的跨度
  onStreakApply() {
    this.applyStreak(this.data.days);
  },

  // 「连续 N 天」右侧的日期预览，点之前就知道会填成什么
  updateStreakPreview() {
    const { days } = this.data;
    const t = dateUtil.today();
    const end = dateUtil.addDays(t, days - 1);
    this.setData({
      streakRangeText: dateUtil.dayShort(t) + ' - ' + dateUtil.dayShort(end),
      daysMinusOff: days <= STREAK_MIN ? 'off' : '',
      daysPlusOff: days >= STREAK_MAX ? 'off' : '',
    });
  },

  // 当前区间恰好等于某个预设时高亮它，用户一眼看得出「现在处于哪个预设」
  refreshQuickActive() {
    const { startDate, startTime, endDate, endTime, days } = this.data;
    const t = dateUtil.today();
    const sameDay = startDate === t && endDate === t;

    let active = '';
    if (sameDay && startTime === '08:30' && endTime === '12:00') active = 'am';
    else if (sameDay && startTime === '12:00' && endTime === '18:00') active = 'pm';
    else if (sameDay && startTime === '08:30' && endTime === '18:00') active = 'day';
    else if (
      startDate === t &&
      startTime === '08:30' &&
      endTime === '18:00' &&
      endDate === dateUtil.addDays(t, days - 1)
    ) {
      active = 'streak';
    }

    const quickButtons = this.data.quickButtons.map((b) =>
      Object.assign({}, b, { active: b.kind === active ? 'on' : '' })
    );
    this.setData({ quickButtons, streakActive: active === 'streak' ? 'on' : '' });
  },

  async submit() {
    if (this.data.submitting) return;
    if (!this.data.joined) {
      wx.showToast({ title: '请先认领身份', icon: 'none' });
      return;
    }

    const { type, startDate, startTime, endDate, endTime, note } = this.data;

    // 「在办公室」不再是可选项，所以必须主动选一个，
    // 不能让默认值代劳——否则会把在岗的人误报成外出。
    if (!type) {
      wx.showToast({ title: '请先选择去向', icon: 'none' });
      return;
    }
    // 备注已是必填：出差填「出差地」、请假填「请假事由」。
    // 提示语带上具体名字，比笼统的「请填写备注」更容易让人知道缺什么。
    if (!note || !note.trim()) {
      wx.showToast({ title: '请填写' + noteUtil.noteMeta(type).label, icon: 'none' });
      return;
    }
    if (tsOf(endDate, endTime) <= tsOf(startDate, startTime)) {
      wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' });
      return;
    }
    if (dateUtil.daysBetween(startDate, endDate) > SPAN_LIMIT_DAYS) {
      wx.showToast({ title: '时间跨度不能超过 30 天', icon: 'none' });
      return;
    }

    const payload = {
      action: 'save',
      type,
      startDate,
      startTime,
      endDate,
      endTime,
      note: note.trim(),
    };

    this.setData({ submitting: true, submitText: '保存中' });
    try {
      const { result } = await wx.cloud.callFunction({ name: 'presence', data: payload });
      if (result && result.success) {
        wx.showToast({ title: '已更新', icon: 'success' });
        this.setData({ note: '' });
        // 直接用写接口回传的列表，省掉一次云函数往返
        this.applyMyList(result.list);
      } else {
        wx.showToast({ title: (result && result.message) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      console.error('保存去向失败', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false, submitText: '保存' });
    }
  },

  // 把服务端返回的记录列表转成渲染结构。
  // 云函数的 save / remove 会顺带回传最新列表，直接用它即可，
  // 不必再发一次「查询我的记录」的请求——那一次往返在冷启动时能占到 1~3 秒。
  applyMyList(rawList) {
    const list = (rawList || []).map((r) => ({
      _id: r._id,
      type: r.type,
      typeLabel: statusUtil.typeLabel(r.type),
      typeClass: 'tag-' + r.type,
      rangeText: r.rangeText,
      dateText: r.dateText,
      note: r.note,
    }));
    this.setData({ myList: list });
    // 记录变了，历史备注也跟着变（刚填过的会排到最前）
    this.refreshNoteHistory();
  },

  // 按当前去向类型，从「我的记录」里提出同类备注作为可点选项。
  // 出差（京内/京外）合并成一组、请假单独一组，口径见 utils/note.js。
  refreshNoteHistory() {
    this.setData({
      noteHistory: noteUtil.noteHistory(this.data.myList, this.data.type),
    });
  },

  // 点历史标签 → 直接填入输入框
  onPickNote(e) {
    this.setData({ note: e.currentTarget.dataset.note });
  },

  async loadMine() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'mine' },
      });
      if (!result || !result.success) return;
      this.applyMyList(result.list);
    } catch (e) {
      console.error('加载我的记录失败', e);
    }
  },

  async removeRecord(e) {
    const id = e.currentTarget.dataset.id;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除记录',
        content: '确定删除这条去向记录吗？',
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
        data: { action: 'remove', id },
      });
      if (result && result.success) {
        wx.showToast({ title: '已删除', icon: 'success' });
        this.applyMyList(result.list);
      } else {
        wx.showToast({ title: (result && result.message) || '删除失败', icon: 'none' });
      }
    } catch (err) {
      console.error('删除记录失败', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  goBoard() {
    wx.switchTab({ url: '/pages/board/board' });
  },
});
