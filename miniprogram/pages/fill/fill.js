const dateUtil = require('../../utils/date');
const statusUtil = require('../../utils/status');
const noteUtil = require('../../utils/note');

// 起止日期跨度上限。出差最长按 30 天算，超过就拦下来，防止手滑选错月份。
const SPAN_LIMIT_DAYS = 30;
// 可选日期范围：允许补填过去 7 天，提前填未来 30 天
const PAST_DAYS = 7;
const FUTURE_DAYS = 30;
// 「连续 N 天」的天数范围，上限与跨度上限一致。
// 两个下限不同，因为「1 天」在两行里的处境不一样：
//   「今天起」最少 2 天 —— 1 天就是「今天整天」，上面已经有现成按钮，不必重复。
//   「明天起」最少 1 天 —— 1 天是「明天整天」，没有任何按钮能替代，必须允许。
const STREAK_MIN = 2;
const STREAK_MIN_TOMORROW = 1;
const STREAK_MAX = SPAN_LIMIT_DAYS;

// 把「日期 + 时刻」转成时间戳。
// 小程序跑在用户手机上，本地时区就是 +08:00，直接构造即可；
// 云函数那边运行在 UTC，写法完全不同，两处不要互相复制。
function tsOf(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00').getTime();
}

// 原先这里还有 pad2 / minToText / bumpHour 三个辅助函数，专供「结束时刻早于开始时刻
// 就自动顺延一小时」那段联动使用。联动去掉后它们全成了死代码，一并删除。

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
    // 区间非法时的行内提示（结束早于开始、跨度过大）。
    // 去掉自动纠正后必须补上它，否则用户只能等提交时才知道填错了。
    rangeWarnText: '',

    // 快捷选项。点按钮会连同日期一起写好，所以「今天上午」这类标签
    // 必须写清「今天」——它们不以当前选中的日期为锚点。
    quickButtons: [],
    // 两行「连续 N 天」的天数**各自独立**存放（days / daysTomorrow）：
    // 改一行的天数不会影响另一行，也没有任何跨行联动。
    // 这是刻意的——曾经「连续 5 天 + 点京内 → 5 天被缩成 1 天」那种隐式联动被用户明确要求去掉过。
    days: 2,
    streakRangeText: '',
    streakActive: '',
    daysMinusOff: '',
    daysPlusOff: '',
    daysTomorrow: 2,
    streakTomorrowRangeText: '',
    streakTomorrowActive: '',
    daysTomorrowMinusOff: '',
    daysTomorrowPlusOff: '',

    // 备注栏：出差时标题是「出差地」、请假时是「请假事由」，且为必填。
    // 文案全部在 JS 里算好——WXML 的 {{}} 里不能出现中文字符串字面量。
    note: '',
    noteTitle: noteUtil.noteMeta('').title,
    notePlaceholder: noteUtil.noteMeta('').placeholder,
    // 请假事由的固定选项（事假/病假/年休假/…），只有选了「请假」才显示。
    // active 在 JS 里算好，WXML 只做插值——和 quickButtons 同一套写法。
    isLeave: false,
    leaveReasons: [],
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
      leaveReasons: noteUtil.LEAVE_REASONS.map((t) => ({ text: t, active: '' })),
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

  // 算跨度文案，同时检查区间是否合法。
  // 时间段联动已全部去掉（改哪个字段就只改那个字段），所以「结束早于开始」
  // 变成用户能手动选出来的状态，必须在这里给即时反馈——
  // 否则只能等点「保存」时才被 toast 拦下，前面几步白填。
  refreshSpan() {
    const { startDate, startTime, endDate, endTime } = this.data;
    const diff = dateUtil.daysBetween(startDate, endDate);
    const over = diff > SPAN_LIMIT_DAYS;
    let spanText = '同一天内';
    if (diff === 1) spanText = '跨 2 天';
    else if (diff > 1) spanText = '跨 ' + (diff + 1) + ' 天';
    if (over) spanText = '跨 ' + (diff + 1) + ' 天，超过 ' + SPAN_LIMIT_DAYS + ' 天上限';

    // 行内警告：文案在 JS 里算好，WXML 只做插值
    let rangeWarnText = '';
    if (tsOf(endDate, endTime) <= tsOf(startDate, startTime)) {
      rangeWarnText = '结束时间需晚于开始时间';
    } else if (over) {
      rangeWarnText = '时间跨度不能超过 ' + SPAN_LIMIT_DAYS + ' 天';
    }

    this.setData({ spanText, spanWarn: over || !!rangeWarnText, rangeWarnText });
  },

  onPickType(e) {
    const value = e.currentTarget.dataset.value;
    const types = this.data.types.map((x) =>
      Object.assign({}, x, { active: x.value === value ? 'on' : '' })
    );
    // 备注标题跟着去向走：出差=出差地，请假=请假事由
    const meta = noteUtil.noteMeta(value);
    // 切换去向时，原来那笔备注在新去向里可能不合法，不合法就当场清掉——
    // 否则会留下一个「改不掉又提交不了」的值（请假时输入框根本不存在）。
    //   切到请假：只有 7 个固定事由算合法，手打的出差地一律清掉
    //   切离请假：原本选的「年休假」当出差地是错的，也要清掉
    // 其余情况保留用户已经写好的文字。
    const prev = this.data.note;
    const isReason = noteUtil.isLeaveReason(prev);
    const note = (value === 'leave') === isReason ? prev : '';
    const patch = {
      types,
      type: value,
      // 只有请假有固定事由选项；出差不带（地名没有可选集合）
      isLeave: value === 'leave',
      note,
      noteTitle: meta.title,
      notePlaceholder: meta.placeholder,
    };

    // 只改去向本身，**不碰时间段**。
    //
    // 早先这里有一段联动：切到「京外/请假」自动把结束日期延到次日，切到「京内」
    // 自动把结束日期收回同一天。本意是省一步操作，但副作用很糟——
    // 用户先用「连续 5 天」把日期铺好，再点一下「京内出差」，那 5 天会被硬缩成 1 天，
    // 看起来完全像出了 bug。所以整段去掉，时间段改为完全手动。
    // 非法区间（结束早于开始）由 refreshSpan 实时提示，提交时再拦一次。
    this.setData(patch);
    this.refreshSpan();
    this.refreshQuickActive();
    // 换了去向，历史备注也要换一组（出差地 ⇄ 请假事由 不混用）
    this.refreshNoteHistory();
    // 已经填过「年休假」再切回请假时，对应的那个选项要跟着亮起来
    this.refreshReasonActive();
  },

  // 下面四个改动「时间段」的方法都只改自己被改的那一个字段，
  // 不再顺手调整对方（「改 A 导致 B 也变」正是用户困惑的来源）。
  // 顺序问题由 refreshSpan 的实时提示 + 提交校验来兜。

  onStartDateChange(e) {
    const startDate = e.detail.value;
    this.setData({ startDate, startDateText: dateUtil.dayLabel(startDate) });
    this.refreshSpan();
    this.refreshQuickActive();
  },

  onStartTimeChange(e) {
    this.setData({ startTime: e.detail.value });
    this.refreshSpan();
    this.refreshQuickActive();
  },

  onEndDateChange(e) {
    const endDate = e.detail.value;
    this.setData({ endDate, endDateText: dateUtil.dayLabel(endDate) });
    this.refreshSpan();
    this.refreshQuickActive();
  },

  onEndTimeChange(e) {
    this.setData({ endTime: e.detail.value });
    this.refreshSpan();
    this.refreshQuickActive();
  },

  // 出差地的输入框。请假时这个框不渲染（事由只能点选），
  // 这里仍加一道兜底：万一有残留的输入事件飘进来，也不能把请假事由改写成自由文字。
  onNoteChange(e) {
    if (this.data.isLeave) return;
    this.setData({ note: e.detail.value });
    this.refreshReasonActive();
  },

  // 点请假事由选项 → 记进备注（就是这条请假记录的事由）。
  // 再点一下取消，方便改了主意又不想选（不选提交时会被拦下）。
  onPickReason(e) {
    const text = e.currentTarget.dataset.text;
    const note = this.data.note === text ? '' : text;
    this.setData({ note });
    this.refreshReasonActive();
  },

  // 当前备注正好等于某个固定选项时高亮它。
  // 只有完全相等才算——所以请假事由永远只会是这 7 项之一。
  refreshReasonActive() {
    const note = String(this.data.note || '').trim();
    this.setData({
      leaveReasons: this.data.leaveReasons.map((r) =>
        Object.assign({}, r, { active: r.text === note ? 'on' : '' })
      ),
    });
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

  // 「连续 N 天」。offset=0 从今天起、offset=1 从明天起，两行共用这一段逻辑。
  // 起点 08:30、终点第 N 天的 18:00。
  // 天数只写回自己那一行的字段（days / daysTomorrow），**另一行的天数原样不动**。
  //
  // offset 必须给默认值 0：漏传时 `addDays(t, undefined)` 会算出 Invalid Date，
  // 结果是 startDate 变成 NaN、区间校验静默失效（不报错，只是警告不出现）。
  applyStreak(days, offset = 0) {
    const isTomorrow = offset > 0;
    const min = isTomorrow ? STREAK_MIN_TOMORROW : STREAK_MIN;
    const n = Math.min(STREAK_MAX, Math.max(min, days));
    const start = dateUtil.addDays(dateUtil.today(), offset);
    const end = dateUtil.addDays(start, n - 1);

    const patch = {
      startDate: start,
      startDateText: dateUtil.dayLabel(start),
      startTime: '08:30',
      endDate: end,
      endDateText: dateUtil.dayLabel(end),
      endTime: '18:00',
    };
    if (isTomorrow) patch.daysTomorrow = n;
    else patch.days = n;

    this.setData(patch);
    this.refreshSpan();
    this.updateStreakPreview();
    this.refreshQuickActive();
  },

  // 加减号：改天数并立即应用，所见即所得
  onDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    this.applyStreak(this.data.days + delta, 0);
  },

  // 点整行（不是加减号）也应用一次，方便重复填同样的跨度
  onStreakApply() {
    this.applyStreak(this.data.days, 0);
  },

  onTomorrowDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    this.applyStreak(this.data.daysTomorrow + delta, 1);
  },

  onTomorrowStreakApply() {
    this.applyStreak(this.data.daysTomorrow, 1);
  },

  // 两行「连续 N 天」右侧的日期预览，点之前就知道会填成什么
  updateStreakPreview() {
    const { days, daysTomorrow } = this.data;
    const t = dateUtil.today();
    const tomorrow = dateUtil.addDays(t, 1);
    const endToday = dateUtil.addDays(t, days - 1);
    const endTomorrow = dateUtil.addDays(tomorrow, daysTomorrow - 1);

    this.setData({
      streakRangeText: dateUtil.dayShort(t) + ' - ' + dateUtil.dayShort(endToday),
      daysMinusOff: days <= STREAK_MIN ? 'off' : '',
      daysPlusOff: days >= STREAK_MAX ? 'off' : '',
      streakTomorrowRangeText:
        dateUtil.dayShort(tomorrow) + ' - ' + dateUtil.dayShort(endTomorrow),
      daysTomorrowMinusOff: daysTomorrow <= STREAK_MIN_TOMORROW ? 'off' : '',
      daysTomorrowPlusOff: daysTomorrow >= STREAK_MAX ? 'off' : '',
    });
  },

  // 当前区间恰好等于某个预设时高亮它，用户一眼看得出「现在处于哪个预设」。
  // 两行「连续 N 天」的起点一个是今天、一个是明天，区间不可能重合，
  // 所以任何时刻最多只有一行亮起，不会出现两行同时高亮的歧义。
  refreshQuickActive() {
    const { startDate, startTime, endDate, endTime, days, daysTomorrow } = this.data;
    const t = dateUtil.today();
    const tomorrow = dateUtil.addDays(t, 1);
    const sameDay = startDate === t && endDate === t;

    let active = '';
    if (sameDay && startTime === '08:30' && endTime === '12:00') active = 'am';
    else if (sameDay && startTime === '12:00' && endTime === '18:00') active = 'pm';
    else if (sameDay && startTime === '08:30' && endTime === '18:00') active = 'day';
    else if (startTime === '08:30' && endTime === '18:00') {
      if (startDate === t && endDate === dateUtil.addDays(t, days - 1)) active = 'streak';
      else if (startDate === tomorrow && endDate === dateUtil.addDays(tomorrow, daysTomorrow - 1))
        active = 'streakTomorrow';
    }

    const quickButtons = this.data.quickButtons.map((b) =>
      Object.assign({}, b, { active: b.kind === active ? 'on' : '' })
    );
    this.setData({
      quickButtons,
      streakActive: active === 'streak' ? 'on' : '',
      streakTomorrowActive: active === 'streakTomorrow' ? 'on' : '',
    });
  },

  async submit() {
    if (this.data.submitting) return;
    // 未认领不再挡在页面入口（小程序审核要求：打开就能看到核心功能），
    // 改在「点保存」这一刻拦。用 showModal 而不是 toast——
    // 既要说明为什么不能提交，也要给一条直接去认领的路；
    // 选「继续填写」时页面数据不丢，用户可以填完再回去认领。
    if (!this.data.joined) {
      const res = await new Promise((resolve) => {
        wx.showModal({
          title: '还没有认领身份',
          content: '填写的内容还在，不会丢。请先到「我的」里从部门名册中认领自己，再回来提交。',
          confirmText: '去认领',
          cancelText: '继续填写',
          success: resolve,
          fail: () => resolve({ confirm: false }),
        });
      });
      if (res.confirm) this.goMine();
      return;
    }

    const { type, startDate, startTime, endDate, endTime, note } = this.data;

    // 「在办公室」不再是可选项，所以必须主动选一个，
    // 不能让默认值代劳——否则会把在岗的人误报成外出。
    if (!type) {
      wx.showToast({ title: '请先选择去向', icon: 'none' });
      return;
    }
    // 备注是必填的：出差填「出差地」（自由文字，非空即可）、
    // 请假选「请假事由」（只能是 7 个固定选项之一）。
    // 规则统一走 noteUtil.isValidNote()，前端提示与云函数校验对齐同一套口径。
    // 提示语带上具体名字，比笼统的「请填写备注」更容易让人知道缺什么。
    if (!noteUtil.isValidNote(type, note)) {
      // 请假是点选项、出差是打字，动词跟着交互方式走（「请选择」/「请填写」）
      const verb = type === 'leave' ? '请选择' : '请填写';
      wx.showToast({ title: verb + noteUtil.noteMeta(type).label, icon: 'none' });
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
        // 备注清空后要把选项的高亮一并撤掉，
        // 否则输入框已空、选项还亮着，看起来像还选着一个事由。
        this.setData({ note: '' });
        this.refreshReasonActive();
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
  // 只有出差有历史（京内 + 京外合并成一组）：请假事由是 7 个固定选项、
  // 不接受自定义文字，所以不给历史——口径见 utils/note.js 的 noteHistory()。
  refreshNoteHistory() {
    this.setData({
      noteHistory: noteUtil.noteHistory(
        this.data.myList,
        this.data.type,
        noteUtil.HISTORY_LIMIT
      ),
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
