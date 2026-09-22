// 图标不用图片文件，由 index.wxss 用纯 CSS 画（.ico-board / .ico-fill / .ico-mine）。
// 原因：本地 .svg 在真机上不显示；换成 .png 后依然空白，而路径、打包配置、
// 样式都排查过没有问题。改成几何绘制后不再依赖任何资源文件，也不会再有这类坑。
// 要换图标形状就改 wxss，不用碰这里；assets/tabbar/ 下的图已是废弃资源。
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/board/board', text: '在位看板', ico: 'board' },
      { pagePath: '/pages/fill/fill', text: '填写去向', ico: 'fill' },
      { pagePath: '/pages/mine/mine', text: '我的', ico: 'mine' },
    ],
  },

  lifetimes: {
    // 每个 tab 页下的自定义 tabBar 是**不同的组件实例**，新实例的 selected 从默认值 0 开始，
    // 要等页面 onShow 里 setData 才纠正过来——中间那一帧就是社区里说的「切页闪一下」。
    // 在组件自己的 attached 里按当前页面路径先算一次，页面还没画出来就已经对了。
    attached() {
      this.syncSelected();
    },
  },

  // 覆盖「从非 tab 页（如名册管理）返回」的场景
  pageLifetimes: {
    show() {
      this.syncSelected();
    },
  },

  methods: {
    syncSelected() {
      let pages = [];
      try {
        pages = getCurrentPages() || [];
      } catch (e) {
        return;
      }
      const cur = pages[pages.length - 1];
      if (!cur || !cur.route) return;
      const idx = this.data.list.findIndex((x) => x.pagePath === '/' + cur.route);
      if (idx >= 0 && idx !== this.data.selected) this.setData({ selected: idx });
    },

    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      // 先点亮再跳转，否则等 switchTab 完成期间高亮还停在上一项
      this.setData({ selected: index });
      wx.switchTab({ url: this.data.list[index].pagePath });
    },
  },
});
