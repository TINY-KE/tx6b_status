// 备注栏（出差地 / 请假事由）的文案与历史提取。
//
// 抽成纯函数的原因：这段逻辑要单测（去重、按类型过滤、限量、边界），
// 写在 Page 里就得连 setData 一起桩掉才能测。这里不碰 this、不碰 setData。

// 「出差」在数据结构里是两种：京内=meeting、京外=trip。
// 但它们共用同一个备注栏（标题都是「出差地」），所以历史必须**合并**这两种，
// 不能只按当前选中的那一个类型取——否则在京内/京外之间切换时会看到两组不同的历史。
const TRIP_TYPES = ['meeting', 'trip'];

// 最多给几个历史选项。太多会把输入框挤到看不见，也失去「点一下」的意义。
const HISTORY_LIMIT = 8;

// 请假事由的固定选项。
// 请假事由就那么几种，每次手打既慢又容易写出「年假 / 年休假 / 公休」这类同义不同字，
// 看板和统计里就没法归并了——所以改成点选。
// 顺序按日常出现频率排，最常用的排前面，常用的点起来手不用移动太远。
// 出差（京内/京外）不设固定选项：出差地是地名，没有可选集合。
//
// **这是请假事由的完整取值域**：请假时不给输入框，只能从这 7 项里选一个，
// 目的是让统计口径干净（否则「年假」「公休」「年休假」会各算一类）。
// 校验统一走 isValidNote()，别在别处另写一份判断。
const LEAVE_REASONS = ['事假', '病假', '年休假', '探亲假', '婚假', '产假', '丧假'];

// 按当下的去向类型，返回备注栏的标题 / 简短名 / 占位文案。
// 未选去向时给一套兜底文案：备注卡本身在未选去向时不渲染（fill.wxml 的 wx:if="{{type}}"），
// 这里的兜底只为 data 初值不留 undefined，正常交互下不会显示出来。
function noteMeta(type) {
  if (TRIP_TYPES.indexOf(type) >= 0) {
    return {
      label: '出差地',
      title: '出差地（必填）',
      placeholder: '例如：市发改委、朝阳区、上海',
    };
  }
  if (type === 'leave') {
    return {
      label: '请假事由',
      title: '请假事由（必选）',
      // 请假时输入框是不渲染的（只能从 7 项里选），这个占位文案只在
      // 切换到请假的一瞬间、输入框还没被 wx:if 撤掉时可能出现，留一句指向选项的话。
      placeholder: '请从上方选择',
    };
  }
  return {
    label: '备注',
    title: '备注（必填）',
    placeholder: '请先选择去向',
  };
}

// 请假时用来渲染选项的文案（未选请假则给空数组，调用方直接用它控制显隐）。
function leaveReasonOptions(type) {
  return type === 'leave' ? LEAVE_REASONS.slice() : [];
}

// 这条备注是否等于某个固定选项。
// 用来决定选项要不要高亮：只有完全相等才算选中。
function isLeaveReason(text) {
  return LEAVE_REASONS.indexOf(String(text || '').trim()) >= 0;
}

// 备注对当前去向是否合法——提交校验和「切换去向时清掉非法文案」共用这一条规则。
//   出差（京内/京外）：出差地是自由文字，非空即可
//   请假：必须是 7 个固定事由之一，**不接受任何自定义文字**
//   未选去向：一律不合法（此时不该提交）
function isValidNote(type, text) {
  const t = String(text || '').trim();
  if (TRIP_TYPES.indexOf(type) >= 0) return t.length > 0;
  if (type === 'leave') return LEAVE_REASONS.indexOf(t) >= 0;
  return false;
}

// 从「我的记录」里挑出同类备注，去重后按「最近用过」排序。
// records 需按时间倒序（云函数 fetchMyRecords 就是 desc），
// 所以第一次见到的那个值就是最近用过的，直接按出现顺序保留即可。
//
// 只服务出差（京内 + 京外合并成一组）：请假事由已是 7 个固定选项，
// 存量的自定义请假备注（「照料家人」之类）在新规则下填不回去，
// 给出这些历史反而是给用户一条走不通的路，所以请假直接返回空。
function noteHistory(records, type, limit) {
  const max = limit || HISTORY_LIMIT;
  const out = [];
  // 未选去向不给历史：此时标题还是兜底的「备注」，填进去大概率是错的。
  // 请假不给历史：见上面说明。
  const want = TRIP_TYPES.indexOf(type) >= 0 ? TRIP_TYPES : [];
  if (!want.length) return out;

  const seen = {};
  const list = records || [];

  for (let i = 0; i < list.length; i++) {
    if (out.length >= max) break;
    const r = list[i];
    if (!r || want.indexOf(r.type) < 0) continue;
    const text = String(r.note || '').trim();
    // 老记录里大量 note 为空（必填是后加的），必须跳过，
    // 否则历史里会混进一个点不动的空标签。
    if (!text || seen[text]) continue;
    seen[text] = true;
    out.push(text);
  }
  return out;
}

module.exports = {
  noteMeta,
  noteHistory,
  leaveReasonOptions,
  isLeaveReason,
  isValidNote,
  TRIP_TYPES,
  HISTORY_LIMIT,
  LEAVE_REASONS,
};
