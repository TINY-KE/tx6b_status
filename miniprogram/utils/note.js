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

// 按当下的去向类型，返回备注栏的标题 / 简短名 / 占位文案。
// 未选去向时给一套兜底文案：标题不能是空的，否则输入框上边会留一块空白。
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
      title: '请假事由（必填）',
      placeholder: '例如：年休假、事假、病假',
    };
  }
  return {
    label: '备注',
    title: '备注（必填）',
    placeholder: '请先选择去向',
  };
}

// 从「我的记录」里挑出同类备注，去重后按「最近用过」排序。
// records 需按时间倒序（云函数 fetchMyRecords 就是 desc），
// 所以第一次见到的那个值就是最近用过的，直接按出现顺序保留即可。
function noteHistory(records, type, limit) {
  const max = limit || HISTORY_LIMIT;
  const out = [];
  // 未选去向时不给历史：此时标题还是兜底的「备注」，填进去大概率是错的。
  if (!type) return out;

  const want = TRIP_TYPES.indexOf(type) >= 0 ? TRIP_TYPES : [type];
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
  TRIP_TYPES,
  HISTORY_LIMIT,
};
