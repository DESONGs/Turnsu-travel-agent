// Expected labels are fixed before provider calls. These fictional source facts
// test language interpretation, not live inventory or travel feasibility.
export const travelJudgmentCases = [
  { id: "quiet", objective: "比较这几家酒店，我更喜欢安静的", evidence: ["房间远离街道，隔音实测良好", "夜间楼下酒吧持续放音乐", "酒店没有提供噪声或隔音信息"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "local_food", objective: "比较这些餐厅，更喜欢本地家常菜", evidence: ["菜单以当地传统家常菜为主", "菜单只供应美式汉堡，不供应本地菜", "只有店名，没有菜单资料"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "not_lively", objective: "只比较住宿氛围，我不喜欢热闹，更喜欢清静", evidence: ["住客休息区安静，夜间无娱乐活动", "每晚举办大型派对，音乐持续至凌晨", "页面未描述氛围和夜间活动"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "correction", objective: "刚才说喜欢热闹说反了。我更喜欢安静，比较这些酒店", evidence: ["客房隔音良好，位于安静内院", "酒店主打热闹的夜间音乐派对", "没有隔音、噪声或夜间活动信息"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "indoors", objective: "比较这些活动，我更喜欢室内展览", evidence: ["全部展览位于室内展厅", "只提供露天步道，没有室内展览", "资料只说有展览，地点未知"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "low_spoiler", objective: "比较介绍方式，我喜欢保留惊喜、少剧透的介绍", evidence: ["只给交通与开放信息，不描述展览内容", "详细逐幕揭示演出剧情及结局", "只有预订链接，没有内容介绍"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "quiet_holdout", objective: "挑住宿风格时我倾向清静一些，请比较现有选项", evidence: ["内院环境清静，夜晚安静", "通宵音乐酒吧就在客房楼下", "住宿页面没有环境介绍"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "art_holdout", objective: "比较这些地方，我偏爱看艺术展", evidence: ["常设绘画及雕塑展", "这是纯购物中心，明确无展览", "未提供用途、展览或活动资料"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "food_holdout", objective: "想比较这些餐厅，我偏爱清淡口味", evidence: ["菜单提供少油少盐的清淡菜", "只供应重油重盐菜，无法调整口味", "菜单没有口味信息"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "outdoors_holdout", objective: "我喜欢户外环境，比较这些活动", evidence: ["活动全程在户外公园进行", "活动仅在封闭地下室内进行", "地点及室内外信息均未提供"], expected: ["supported", "conflict", "unknown"], scope: "compare" },
  { id: "parent_route", objective: "替我规划上海三天的完整行程，午休要回酒店", evidence: ["内院环境安静", "楼下夜间音乐活动", "未提供酒店设施信息"], expected: null, scope: "planning" },
  { id: "parent_budget", objective: "预算不能超过6000，帮我修改整个行程", evidence: ["酒店价格未知", "房间费用有历史参考价", "未提供费用"], expected: null, scope: "planning" },
  { id: "parent_confirm", objective: "我确认选择第二家酒店，把它写入行程", evidence: ["酒店一", "酒店二", "酒店三"], expected: null, scope: "planning" },
  { id: "parent_dates", objective: "改成10月3日出发，再比较这些酒店的价格", evidence: ["价格日期未知", "价格只覆盖9月", "没有库存资料"], expected: null, scope: "planning" },
  { id: "parent_accessibility", objective: "同行人必须全程无台阶，这些酒店要满足这个硬性要求", evidence: ["只知道酒店有电梯", "入口已知有台阶", "设施信息缺失"], expected: null, scope: "planning" },
  { id: "parent_lock", objective: "原来已订的酒店别动，但第二天要改去另一个城市", evidence: ["现有酒店", "候选酒店", "未知酒店"], expected: null, scope: "planning" },
];
