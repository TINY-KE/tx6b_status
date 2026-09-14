// 全局配置：云开发环境 ID（已填入本项目的环境）
// 在微信开发者工具 → 云开发 → 设置 → 环境 ID 中可核对
const CLOUD_ENV_ID = 'cloud1-d7g87r7wxb0945808';

App({
  globalData: {
    envId: CLOUD_ENV_ID,
    // 当前微信身份对应的员工档案（认领名册后才有值）
    me: null,
    isAdmin: false,
    // 科室列表，由云函数下发，避免前后端各写一份
    deptOptions: [],
    // 名册是否为空（用于显示「创建首个身份」入口）
    rosterEmpty: false,
  },

  onLaunch() {
    this.globalData.envReady = this.initCloud();
    this.globalData.readyPromise = this.bootstrap();
  },

  initCloud() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，无法使用云能力，请升级到 2.2.3 以上');
      return false;
    }
    const configured = CLOUD_ENV_ID && CLOUD_ENV_ID.indexOf('REPLACE_WITH') !== 0;
    if (configured) {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true,
      });
    } else {
      // 未填写环境 ID 时退回「默认环境」：AppID 下只开通了一个云环境时同样可用。
      // 这样刚开通云开发、还没拿到环境 ID 时不会整个小程序瘫痪。
      // 一旦你有了多个环境，务必在上面填明确的环境 ID，否则会连到错误的环境。
      console.warn('未配置 CLOUD_ENV_ID，已回退到默认云环境。建议在 app.js 中填入明确的环境 ID');
      wx.cloud.init({ traceUser: true });
    }
    return true;
  },

  // 静默登录：仅凭 openid 获取身份，不要求用户填写任何信息。
  // 未认领名册时 me 为 null，前端引导去「我的 → 认领身份」。
  async bootstrap() {
    if (!this.globalData.envReady) {
      return { success: false, message: '云环境未就绪' };
    }
    try {
      const { result } = await wx.cloud.callFunction({ name: 'login' });
      if (result && result.success) {
        this.globalData.me = result.me || null;
        this.globalData.isAdmin = !!(result.me && result.me.isAdmin);
        this.globalData.deptOptions = result.deptOptions || [];
        // 名册是否为空：为空时前端要显示「创建首个身份」入口
        this.globalData.rosterEmpty = !!result.rosterEmpty;
      }
      return result || { success: false };
    } catch (e) {
      console.error('初始化身份失败', e);
      return { success: false, message: '网络异常' };
    }
  },

  // 页面统一 await 这个，保证身份已就绪
  ensureReady() {
    if (!this.globalData.readyPromise) {
      this.globalData.readyPromise = this.bootstrap();
    }
    return this.globalData.readyPromise;
  },

  // 认领身份 / 修改资料后刷新全局状态
  refresh() {
    this.globalData.readyPromise = this.bootstrap();
    return this.globalData.readyPromise;
  },
});
