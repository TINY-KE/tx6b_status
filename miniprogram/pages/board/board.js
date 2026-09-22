const dateUtil = require('../../utils/date');
const statusUtil = require('../../utils/status');
const shareUtil = require('../../utils/share');

const DEPT_KEY = 'presence_last_dept';
const PAGE_STEP = 24; // 一次渲染多少人，避免 100 人一次性铺开卡顿
const FALLBACK_DEPTS = ['1室', '2室', '3室', '4室', '部办'];

// 区间视图定义：screenIndex(1~3) -> 视图。
//   3/7：按「工作日」取列（走 date.js 的 isWorkday，跳过节假日、算上调休），
//        用色条 + 分段渲染；
//   M（一个月）：按「自然日」取 30 列，用每日一格的色块渲染——
//        30 列放不下色条和备注，长假以「空心格」的形态留在月视图里
//        （不填色只留描边：灰已被「请假」占用，同屏两种灰会被看成同一个状态）。
// cloudKey 是传给 presence 云函数 range 的视图标识，也用作页面 data 的后缀
// （cols3 / people3 / cols7 / ... / colsM / peopleM）。
const RANGE_VIEWS = {
  1: { cloudKey: '3', count: 3, workdaysOnly: true },
  2: { cloudKey: '7', count: 7, workdaysOnly: true },
  3: { cloudKey: 'M', count: 30, workdaysOnly: false },
};

// cloudKey -> 视图定义的反查表，loadRange 用
const VIEW_BY_KEY = {};
Object.keys(RANGE_VIEWS).forEach((k) => {
  VIEW_BY_KEY[RANGE_VIEWS[k].cloudKey] = RANGE_VIEWS[k];
});

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

    // 三个区间视图（3个工作日 / 7个工作日 / 一个月）各自独立的数据，
    // 后缀对应 RANGE_VIEWS 里的 cloudKey，互不覆盖、各自懒加载。
    cols3: [],
    people3: [],
    loaded3: false,
    cols7: [],
    people7: [],
    loaded7: false,
    colsM: [],
    peopleM: [],
    loadedM: false,

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

  // 把服务端 applications 整形成弹窗要的结构。三个区间视图共用。
  decorateApps(p) {
    return (p.applications || []).map((a) => ({
      typeName: statusUtil.typeLabel(a.type),
      note: a.note || '',
      rangeLabel: a.rangeLabel || '',
      coverDays: a.coverDays || [],
      cls: 'bd-' + a.type,
    }));
  },

  // 加载某个区间视图（'3' / '7' / 'M'）。各自懒加载、互不覆盖。
  async loadRange(key) {
    if (this['rangeLoading_' + key]) return;
    this['rangeLoading_' + key] = true;
    const def = VIEW_BY_KEY[key];
    // 3/7 视图按工作日取列：跳过法定节假日/调休放假，算上调休上班的周末——
    // 跨长假时列头会自动跳过去（如 9/23 看到 9/23、9/24、9/28）。
    // 一个月视图按自然日取列：周末/节假日以空心格的形态留在月视图里，
    // 一个月的节奏才看得出来（哪些天本来就不用上班）。
    const dates = def.workdaysOnly
      ? dateUtil.nextWorkdays(def.count, this.data.date)
      : dateUtil.nextDays(def.count, this.data.date);
    const compact = key === 'M';
    const t = dateUtil.today();

    const cols = dates.map((d) => {
      const base = {
        date: d,
        today: d === t ? 'on' : '',
        // 调休上班的周末（如 10/10 周六）加个「班」标记，避免看着像把工作日算错了
        badge: dateUtil.isMakeupWorkday(d) ? '班' : '',
      };
      if (compact) {
        // 30 列每列只有约 19rpx，只放日号；周末/节假日整格涂灰
        const rest = !!dateUtil.holidayName(d) || dateUtil.isWeekend(d);
        base.text = String(Number(d.slice(8)));
        base.cls = rest ? 'rest' : '';
        return base;
      }
      if (key === '7') {
        // 7 列每列约 76rpx，放不下「9/24 周四」一行，拆成日期 + 星期两行
        base.text = dateUtil.dayShort(d);
        base.sub = dateUtil.weekdayText(d);
        return base;
      }
      base.text = dateUtil.dayShort(d) + ' ' + dateUtil.weekdayText(d);
      base.sub = '';
      return base;
    });

    const upd = {};
    upd['cols' + key] = cols;
    upd['loaded' + key] = false;
    this.setData(upd);

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'presence',
        data: { action: 'range', dates, dept: this.data.dept, compact },
      });
      if (!result || !result.success) {
        this['rangeLoading_' + key] = false;
        return;
      }
      let people;
      if (compact) {
        // 一个月视图：每人 30 个格子，格子配色在 statusUtil.monthCellClass 里算好
        people = (result.people || []).map((p) => ({
          key: p.openid || 'x' + p.name,
          name: p.name,
          phone: p.phone || '',
          joined: p.joined,
          initial: (p.name || '').slice(0, 1),
          cells: (p.marks || []).map((mark, i) => ({
            cls: statusUtil.monthCellClass(mark, dates[i], p.joined),
          })),
          applications: this.decorateApps(p),
        }));
      } else {
        people = (result.people || []).map((p) => ({
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
          // 显示完整起止区间（含详细时刻），已包含今天及以后（含三天之后）的全部申请。
          applications: this.decorateApps(p),
        }));
      }
      const upd2 = {};
      upd2['people' + key] = people;
      upd2['loaded' + key] = true;
      this.setData(upd2);
    } catch (e) {
      console.error('加载区间视图失败', e);
    } finally {
      this['rangeLoading_' + key] = false;
    }
  },

  // 当前 screenIndex 对应的视图 key；今天屏（0）返回 ''
  viewKeyFor(screenIndex) {
    const def = RANGE_VIEWS[screenIndex];
    return def ? def.cloudKey : '';
  },

  // 科室切换 / 下拉刷新后，把三个区间视图的缓存全部作废，下次进入重新拉
  invalidateRanges() {
    this.setData({ loaded3: false, loaded7: false, loadedM: false });
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
    this.invalidateRanges();
    this.loadToday();
    const key = this.viewKeyFor(this.data.screenIndex);
    if (key) this.loadRange(key);
  },

  onSwiperChange(e) {
    const idx = e.detail.current;
    this.setData({ screenIndex: idx });
    const key = this.viewKeyFor(idx);
    if (key && !this.data['loaded' + key]) {
      this.loadRange(key);
    }
  },

  onScreenTap(e) {
    this.setData({ screenIndex: Number(e.currentTarget.dataset.i) });
  },

  // 点击色条 / 月视图格子 → 弹出该用户「今天及以后（含三天之后）的所有不在岗申请」。
  // 口径与服务端一致：结束时间晚于今天 0 点的申请都列出，每条一条完整记录，不再按天切片。
  // 例如周一申请周四~周六出差，虽然落在三天窗口之外，也会显示出来。
  // data-v 是视图 key（'3' / '7' / 'M'，dataset 里拿到的是字符串）、
  // data-pi 是人员序号、data-di 是被点的那天序号（用于高亮覆盖那天的申请）。
  onTapBar(e) {
    const ds = e.currentTarget.dataset;
    const key = ds.v || '3';
    const pi = Number(ds.pi);
    const di = Number(ds.di);
    const people = this.data['people' + key] || [];
    const person = people[pi];
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
    const key = this.viewKeyFor(this.data.screenIndex);
    if (key) {
      // 下拉刷新当前视图，同时作废另外两个视图的缓存（下次进入重新拉最新数据）
      this.invalidateRanges();
      jobs.push(this.loadRange(key));
    }
    Promise.all(jobs).then(() => wx.stopPullDownRefresh());
  },

  goFill() {
    wx.switchTab({ url: '/pages/fill/fill' });
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  // 右上角「··· → 转发给朋友」。
  //
  // ⚠️ 不定义这个函数，右上角菜单里的「转发给朋友」就是灰的——
  // 官方 Page 文档原文：「只有定义了此事件处理函数，右上角菜单才会显示"转发"按钮」。
  // 这个「灰」不报错、也不受账号认证或发布状态影响，只能靠定义它来解决。
  //
  // 只做「转发给朋友」，不做朋友圈：朋友圈进的是单页模式（无登录态、
  // 云开发接口需单独开未登录访问），这个看板每屏数据都来自云函数，进去会是空的。
  // 详见 utils/share.js 的文件头说明。
  onShareAppMessage() {
    return shareUtil.sharePayload([
      {
        // 看板自己就是落点，转发出去对方点开先看到今天的在位情况
        path: shareUtil.HOME_PATH,
        dateText: this.data.dateTitle,
      },
    ]);
  },
});
