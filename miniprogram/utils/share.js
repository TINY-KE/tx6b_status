// 右上角「··· → 转发给朋友」的分享内容。
//
// 为什么要有这个文件：**只有页面定义了 onShareAppMessage，
// 右上角菜单才会显示"转发"按钮**（官方 Page 文档原文）——
// 不定义时那两项是灰的，且这个「灰」不会报错、也不受账号/发布状态影响。
//
// 四个页面的分享文案本来可以各写一份，但「标题怎么写」是一条全局口径：
// 标题里带上「人员在位」这个用途 + 当天日期，让对方在聊天列表里就看出是什么，
// 而不是一片不知名的「某某的小程序」。所以集中在这里，页面只管把 path 传进来。
//
// ⚠️ 只做「转发给朋友」，不做朋友圈：
// 官方《分享到朋友圈》文档要求「首先页面需设置允许'发送给朋友'」（本项目已满足），
// 但朋友圈分享进的是**单页模式**——无登录态、`wx.cloud.callFunction` 这类
// 云开发接口要另外开「未登录访问」，且不允许跳转到其它页面。
// 这个看板的每一屏数据都来自云函数，单页模式下会直接空掉，
// 所以刻意不定义 onShareTimeline，**别人也找不到入口**。

// 默认分享的落点：看板首页。
// 单页模式那条路走不通的项目里，转发过去就该落在「一打开就能看到核心功能」的页面，
// 这样对方点开先看到看板、再决定要不要认领身份。
const HOME_PATH = '/pages/board/board';

// 标题口径：固定前缀 + 可选后缀。
// 前缀写「人员在位」而不是「在位看板」——群里的人不认得产品名，
// 但一看「人员在位」就知道是干什么的。
const TITLE_PREFIX = '人员在位';

// dateText 由各页面自己传（它们的 data 里都有算好的日期），
// 这里不做日期计算：日期口径统一在 utils/date.js，多算一份就是第二个口径。
function buildTitle(dateText) {
  const d = String(dateText || '').trim();
  return d ? TITLE_PREFIX + ' · ' + d : TITLE_PREFIX;
}

// 生成 onShareAppMessage 的返回值。
//
// 注意 path 必须是**以 / 开头的完整路径**（官方文档原文），
// 写成 'pages/board/board' 这种相对路径会被静默忽略、退回当前页面。
//
// 返回值不写 imageUrl：默认会用当前页面截图，
// 而看板本身就是一张信息图，截图比任何配图都说明问题。
function sharePayload(items) {
  const list = items || [];
  const x = list[0] || {};
  return {
    title: buildTitle(x.dateText),
    path: x.path || HOME_PATH,
  };
}

module.exports = {
  HOME_PATH,
  TITLE_PREFIX,
  buildTitle,
  sharePayload,
};
