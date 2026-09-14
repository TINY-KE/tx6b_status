const dateUtil = require('../../utils/date');
const statusUtil = require('../../utils/status');

const DEPT_KEY = 'presence_last_dept';
const PAGE_STEP = 24; // 一次渲染多少人，避免 100 人一次性铺开卡顿
const FALLBACK_DEPTS = ['1室', '2室', '3室', '4室', '部办'];

// 第二屏色条下方备注（出差地/请假事由）的截断宽度。
// 单列只有约 183rpx（750 - 左右内边距 48 - 姓名列 128 - 两个 12rpx 间距，再除以 3），
// 28rpx 字号下一个汉字占 28rpx，所以最多放得下 6 个汉字 = 12 个等效宽度。
// 超过就截断加省略号——这里不做换行，否则同一行里每列的备注行数不同，
// 三个色条会错位、看不出谁对应哪天。
const NOTE_MAX_UNITS = 12;

Page({
  data: {
    date: '',
    dateTitle: '',
    dept: '',
    deptTabs: [],
    screenIndex: 0,

    axis: [],
    todayPeople: [],
    stats: null,
    hasMore: false,

    recentCols: [],
    recentPeople: [],
    recentLoaded: false,

    // 点色条弹出的「不在岗申请」详情。detail 为 null 时不渲染遮罩。
    showDetail: false,
    detail: null,

    loading: true,
    errorMsg: '',
    joined: false,
    meName: '',
  },

  onLoad() {
    const today = dateUtil.today();
    const dept = wx.getStorageSync(DEPT_KEY) || '';
    this.allPeople = [];
    this.recentCache = null;

    this.setData({
      date: today,
      dateTitle: dateUtil.dayDisplay(today) + ' ' + dateUtil.weekdayText(today),
      dept,
      deptTabs: this.buildDeptTabs(dept),
      axis: this.buildAxis(),
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    const app = getApp();
    app.ensureReady().then((res) => {
      const me = app.globalData.me;
      this.setData({
        joined: !!me,
        meName: me ? me.name : '',
      });
      this.loadToday();
      // 科室有变化（比如管理员改了别人的科室）时刷新标签页
      const dept = this.data.dept;
      if (res && res.deptOptions && res.deptOptions.length) {
        this.deptList = res.deptOptions;
        this.setData({ deptTabs: this.buildDeptTabs(dept) });
      }
    });
  },

  // 时间轴刻度：8:30 / 12:00 / 18:00。
  // left 是相对时间轴区域的百分比，8:30 在第 0 格中心附近，18:00 贴近右端。
  buildAxis() {
    return [
      { text: '8:30', left: 3, align: 'start' },
      { text: '12:00', left: 39.5, align: 'center' },
      { text: '18:00', left: 97, align: 'end' },
    ];
  },

  buildDeptTabs(current) {
    const list = this.deptList || FALLBACK_DEPTS;
    const tabs = [{ value: '', label: '全部' }].concat(
      list.map((d) => ({ value: d, label: d }))
    );
    return tabs.map((t) => ({
      value: t.value,
      label: t.label,
      active: t.value === current ? 'on' : '',
    }));
  },

  // 标签文字截断：中文字符按 2 个宽度、英文/数字按 1 个宽度，超过 maxWidth 显示「…」
  // 看板标签宽度很小，不截断会撑破整行
  ellipsis(str, maxWidth) {
    let width = 0;
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const w = code > 255 ? 2 : 1;
      if (width + w > maxWidth) {
        return out + '…';
      }
      width += w;
      out += str[i];
    }
    return out;
  },

  // 把服务端返回的一行转成可渲染结构。
  // 所有 class 名、展示文本都在这里算好，WXML 里只做变量插值——
  // WXML 表达式不支持方法调用，也不能写含中文的字符串字面量。
  //
  // 标签只在「有信息量」时显示：全天在岗的人不显示标签，
  // 这样 100 人的列表不会被文字撑得过长。
  decorateRow(p) {
    const dotClasses = p.dots.map((t) => {
      if (!p.joined) return 'd-blank';
      // 未填的时段和「未确认在岗」都按在岗（蓝色）显示，不再单独区分
      if (!t) return 'd-office';
      return 'd-' + t;
    });

    let showTag = true;
    let tagLine = '';
    let tagClass = 'tag-blank';

    if (!p.joined) {
      tagLine = '未加入';
    } else {
      const outsiders = p.segments.filter((s) => s.type !== 'office');
      if (outsiders.length) {
        const seg = outsiders[0];
        // 看板标签优先显示备注（出差地 / 请假事由），没有备注时才显示状态名
        const note = (p.tagNote || '').trim();
        const prefix = note || statusUtil.typeShort(seg.type);
        // 标签宽度有限，超长时截断并加省略号；20 等效宽度 ≈ 10 个汉字，
        // 足够「燕岭宾馆」这类 4 字地名完整显示
        tagLine = this.ellipsis(prefix, 20) + ' ' + seg.text;
        tagClass = 'tag-' + seg.type;
        if (outsiders.length > 1) {
          tagLine = tagLine + ' 等 ' + outsiders.length + ' 段';
        }
      } else if (p.segments.length) {
        // 全天同一状态，点阵已经表达清楚，不再重复文字
        showTag = false;
      } else {
        // 没有任何记录：按在岗显示（点阵已全蓝），不再重复文字
        showTag = false;
      }
    }

    return {
      key: p.openid || 'x' + p.name,
      name: p.name,
      // 点姓名要拨号，所以带上电话（本人认领时填的）
      phone: p.phone || '',
      joined: p.joined,
      confirmed: p.confirmed,
      dotClasses,
      showTag,
      tagLine,
      tagClass,
    };
  },

  async loadToday() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'day', date: this.data.date, dept: this.data.dept },
      });
      if (!result || !result.success) {
        this.setData({ loading: false, errorMsg: (result && result.message) || '加载失败' });
        return;
      }
      const people = (result.people || []).map((p) => this.decorateRow(p));
      this.allPeople = people;
      this.setData({
        loading: false,
        stats: result.stats || null,
        todayPeople: people.slice(0, PAGE_STEP),
        hasMore: people.length > PAGE_STEP,
      });
    } catch (e) {
      console.error('加载在位看板失败', e);
      this.setData({ loading: false, errorMsg: '网络异常，下拉重试' });
    }
  },

  onScrollLower() {
    if (!this.data.hasMore) return;
    const cur = this.data.todayPeople.length;
    const next = this.allPeople.slice(cur, cur + PAGE_STEP);
    const total = this.data.todayPeople.length + next.length;
    this.setData({
      todayPeople: this.data.todayPeople.concat(next),
      hasMore: total < this.allPeople.length,
    });
  },

  async loadRecent() {
    if (this.recentLoading) return;
    this.recentLoading = true;
    // 今天起往后 3 个工作日：今天排最左，往右是明天、后天。
    const dates = dateUtil.nextWorkdays(3, this.data.date);
    const t = dateUtil.today();
    const cols = dates.map((d) => ({
      date: d,
      text: dateUtil.dayShort(d) + ' ' + dateUtil.weekdayText(d),
      today: d === t ? 'on' : '',
    }));
    this.setData({ recentCols: cols, recentLoaded: false });

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'range', dates, dept: this.data.dept },
      });
      if (!result || !result.success) {
        this.recentLoading = false;
        return;
      }
      const people = (result.people || []).map((p) => ({
        key: p.openid || 'x' + p.name,
        name: p.name,
        phone: p.phone || '',
        joined: p.joined,
        initial: (p.name || '').slice(0, 1),
        days: p.days.map((day) => {
          // 服务端的 segments 会跳过「没有记录的空档」，而色条是按 span 比例平铺的，
          // 必须先把空档补回来，否则剩下的色块会被拉伸铺满整条——
          // 表现就是「上午出差、下午在岗」，整条却全成了出差色。
          const bars = statusUtil.barsFromSegments(day.segments, '');
          const segs = bars.length ? bars : [{ type: '', span: statusUtil.SLOT_COUNT }];
          // 色条下方列出当天所有「不在岗」时段：备注 + 时间段。
          // 备注为空的老记录（备注是后加的必填项）退化成状态名（京内/京外/请假），
          // 否则色条下面会挂一行空白，看着像没加载出来。
          // typeName / note 是为「点色条弹窗」多带的：弹窗里要显示完整状态名 + 备注，
          // 而色条下方的那行只显示 label（备注为空时退化成状态短名），两者用途不同。
          const items = (day.items || []).map((it) => {
            const note = (it.note || '').trim();
            return {
              label: this.ellipsis(note || statusUtil.typeShort(it.type), NOTE_MAX_UNITS),
              note,
              typeName: statusUtil.typeLabel(it.type),
              time: it.time || '',
              cls: 'bd-' + it.type,
            };
          });
          return {
            bars: segs.map((s) => ({
              flex: s.span,
              barClass: this.segClass(s.type, day.confirmed, day.joined),
            })),
            items,
          };
        }),
        // 点色条弹窗用的「完整申请」：每条是一条记录（跨多天的也只算一条），
        // 显示完整起止区间（含详细时刻），不在岗状态名与配色复用 statusUtil / bd-*。
        // 服务端的 applications 已包含今天及以后（含三天之后）的全部不在岗申请。
        applications: (p.applications || []).map((a) => ({
          typeName: statusUtil.typeLabel(a.type),
          note: a.note || '',
          rangeLabel: a.rangeLabel || '',
          coverDays: a.coverDays || [],
          cls: 'bd-' + a.type,
        })),
      }));
      this.setData({ recentPeople: people, recentLoaded: true });
    } catch (e) {
      console.error('加载近三日失败', e);
    } finally {
      this.recentLoading = false;
    }
  },

  segClass(type, confirmed, joined) {
    if (!joined) return 'bar-blank';
    // 未填与未确认在岗一律按在岗显示
    if (!type) return 'bar-office';
    return 'bar-' + type;
  },

  // 点看板上的姓名 → 给这位同事打电话。
  // 电话是本人认领时自己填的（见「我的」页），所以有「未认领」「已认领但没填」两种情况，
  // 必须分别给提示——点了没反应会让人以为功能坏了。
  onTapName(e) {
    const ds = e.currentTarget.dataset;
    const name = ds.name || '';
    const phone = String(ds.phone || '').trim();
    // dataset 里的值一律是字符串（"true"/"false"），不能当真值用
    const joined = String(ds.joined) === 'true';

    if (!joined) {
      wx.showModal({
        title: '无法拨打电话',
        content: name + ' 还没有认领身份。等他认领并填写电话号码后就能拨打。',
        showCancel: false,
        confirmText: '好的',
      });
      return;
    }
    if (!phone) {
      wx.showModal({
        title: '暂无电话号码',
        content: name + ' 还没有填写电话号码，可以在「我的 → 编辑我的资料」里补充。',
        showCancel: false,
        confirmText: '好的',
      });
      return;
    }

    wx.showModal({
      title: '拨打电话',
      content: '确定要给 ' + name + ' 拨打电话吗？',
      confirmText: '拨打',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        wx.makePhoneCall({
          phoneNumber: phone,
          fail: (err) => {
            // 用户自己点了取消不算失败，别弹错误提示
            if (err && /cancel/i.test(err.errMsg || '')) return;
            wx.showToast({ title: '拨号失败', icon: 'none' });
          },
        });
      },
    });
  },

  onDeptChange(e) {
    const dept = e.currentTarget.dataset.dept || '';
    if (dept === this.data.dept) return;
    wx.setStorageSync(DEPT_KEY, dept);
    this.setData({ dept, deptTabs: this.buildDeptTabs(dept) });
    this.recentCache = null;
    this.loadToday();
    if (this.data.screenIndex === 1) this.loadRecent();
  },

  onSwiperChange(e) {
    const idx = e.detail.current;
    this.setData({ screenIndex: idx });
    if (idx === 1 && !this.data.recentLoaded) {
      this.loadRecent();
    }
  },

  onScreenTap(e) {
    this.setData({ screenIndex: Number(e.currentTarget.dataset.i) });
  },

  // 点击第二屏的色条 → 弹出该用户「今天及以后（含三天之后）的所有不在岗申请」。
  // 口径与服务端一致：结束时间晚于今天 0 点的申请都列出，每条一条完整记录，不再按天切片。
  // 例如周一申请周四~周六出差，虽然落在三天窗口之外，也会显示出来。
  // data-pi 是人员序号、data-di 是被点的那天序号（用于高亮覆盖那天的申请）。
  onTapBar(e) {
    const ds = e.currentTarget.dataset;
    const pi = Number(ds.pi);
    const di = Number(ds.di);
    const person = this.data.recentPeople[pi];
    if (!person) return;
    // 直接列完整申请（每条一条记录），不再按天切片。
    const apps = (person.applications || []).map((a) => ({
      typeName: a.typeName,
      note: a.note,
      rangeLabel: a.rangeLabel,
      cls: a.cls,
      // 这条申请覆盖被点的那天 → 高亮
      focus: !!(a.coverDays && a.coverDays[di]),
    }));
    let emptyText = '暂无不在岗申请';
    if (!person.joined) emptyText = person.name + ' 还没有认领身份，暂无法查看去向详情';
    this.setData({
      showDetail: true,
      detail: { name: person.name, joined: person.joined, apps, hasAny: apps.length > 0, emptyText },
    });
  },

  // 点遮罩或右上角 × 关闭弹窗
  closeDetail() {
    this.setData({ showDetail: false });
  },

  // 点卡片内部时拦截冒泡，避免穿透到遮罩把弹窗关掉
  noop() {},

  onPullDownRefresh() {
    const jobs = [this.loadToday()];
    if (this.data.screenIndex === 1) jobs.push(this.loadRecent());
    Promise.all(jobs).then(() => wx.stopPullDownRefresh());
  },

  goFill() {
    wx.switchTab({ url: '/pages/fill/fill' });
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
