// Binding designs belong to the personal page. They never change the photograph or the drawing.
export const journalTemplates = {
  plain:   { zh: "素纸", en: "Plain paper", cover: "#475044", paper: "#faf5e9", ink: "#34362e", accent: "#857457" },
  song:    { zh: "宋 · 山水册页", en: "Song landscape album", cover: "#707f70", paper: "#f8f3e4", ink: "#303c36", accent: "#9a493d" },
  ming:    { zh: "明 · 线装游记", en: "Ming thread binding", cover: "#34435b", paper: "#f7f0dd", ink: "#2e3542", accent: "#605644" },
  british: { zh: "英伦 · 田野笔记", en: "British field notes", cover: "#394b40", paper: "#f3f1df", ink: "#303c30", accent: "#79613d" },
  egyptian:{ zh: "埃及 · 纸草行记", en: "Egyptian papyrus", cover: "#b59661", paper: "#f7eacc", ink: "#3e372b", accent: "#356569" },
  french:  { zh: "法国 · 旅行画册", en: "French travel carnet", cover: "#865851", paper: "#fcf1e9", ink: "#463735", accent: "#815461" },
  roman:   { zh: "罗马 · 建筑手稿", en: "Roman architectural studies", cover: "#935b45", paper: "#f8eddb", ink: "#40332f", accent: "#93583d" },
  edo:     { zh: "江户 · 东海道名所绘", en: "Edo Tōkaidō prints", cover: "#315675", paper: "#f4f1df", ink: "#273d50", accent: "#305e80" },
  safavid: { zh: "波斯 · 萨法维画册", en: "Safavid album folios", cover: "#253855", paper: "#faf1db", ink: "#353448", accent: "#85692e" },
  mixtec:  { zh: "米斯特克 · 折屏画册", en: "Mixtec screenfold", cover: "#bfa173", paper: "#f8edd7", ink: "#44382e", accent: "#964d39" },
  asante:  { zh: "加纳 · 阿散蒂织纹", en: "Asante strip weave", cover: "#536146", paper: "#f8efdf", ink: "#303b31", accent: "#775b33" },
};

const places = [
  ["ming", /明孝陵|明十三陵|明长城|故宫|紫禁城|Ming Tombs|Forbidden City/i],
  ["song", /黄山|西湖|漓江|桂林山水|Huangshan|West Lake|Li River/i],
  ["british", /大本钟|威斯敏斯特|基尤园|湖区国家公园|Big Ben|Westminster|Kew Gardens|Lake District/i],
  ["egyptian", /吉萨|卢克索|卡纳克|阿布辛贝|Giza|Luxor|Karnak|Abu Simbel/i],
  ["french", /埃菲尔铁塔|卢浮宫|凡尔赛宫|塞纳河|巴黎圣母院|巴黎先贤祠|Eiffel|Louvre|Versailles|River Seine/i],
  ["roman", /罗马斗兽场|古罗马广场|罗马万神殿|圣彼得大教堂|Colosseum|Roman Forum|Pantheon of Rome|St\.? Peter.s Basilica/i],
  ["edo", /东海道|東海道|东京日本桥|東京日本橋|T[oō]kaid[oō]/i],
  ["safavid", /伊玛目广场|伊斯法罕|Isfahan|Naqsh.e Jahan/i],
  ["mixtec", /米斯特克|米斯特卡|蒂兰通戈|Mixteca|Tilantongo/i],
  ["asante", /邦维雷|库马西|Bonwire|Kumasi/i],
];
const localDetails = [
  ["roman", /罗马|\bRome\b|\bRoma\b/i, /万神殿|Pantheon/i],
  ["edo", /东京|東京|Tokyo/i, /日本桥|日本橋|Nihonbashi/i],
  ["ming", /南京|北京|Nanjing|Beijing/i, /明城墙|Ming City Wall/i],
];

export function suggestedJournalTemplate(title = "", location = {}) {
  if (/复制品|模型展|主题酒店|宾馆|酒店|旅馆|replica|hotel|exhibition|resort/i.test(title)) return "plain";
  const area = [location?.city, location?.province, location?.country, location?.label, location?.address].filter(Boolean).join(" ");
  return places.find(([, pattern]) => pattern.test(title))?.[0]
    ?? localDetails.find(([, region, place]) => region.test(area) && place.test(title))?.[0] ?? "plain";
}

export function entryTemplate(entry, node) {
  return Object.hasOwn(journalTemplates, entry?.templateId) ? entry.templateId
    : suggestedJournalTemplate(entry?.placeTitle || node?.title, node?.location);
}
