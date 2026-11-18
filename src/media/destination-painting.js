// A local artistic choice, never an attribution or a new claim about a site.
const penWash = { zh: "钢笔淡彩", en: "Pen and wash", technique: "Use selective pen lines, sparse hatching, warm paper and quiet transparent watercolor." };
const techniques = {
  kucha: { zh: "龟兹壁画色调", en: "Kucha mural palette", technique: "Use fine outlines and quiet ochres, muted blues and mineral washes inspired by the murals of Kizil." },
  tibetanArchitecture: { zh: "藏式建筑矿彩", en: "Tibetan architectural study", technique: "Use precise architectural contours and restrained mineral colors to describe the painted walls already visible." },
  romanAntiquity: { zh: "古迹建筑速写", en: "Antiquity sketch", technique: "Use an architectural field sketch in brown ink, measured elliptical arcs and light stone washes. Show the ruins as they appear today." },
  renaissance: { zh: "文艺复兴建筑素描", en: "Renaissance drawing study", technique: "Use warm chalk and pen on toned paper, directional hatching and architectural perspective to draw the actual photograph." },
  landscapeInk: { zh: "山水淡墨", en: "Landscape ink wash", technique: "Use varied brush pressure, broken ink texture, reserved paper for mist and muted mineral washes. Keep the original ridges and skyline." },
  steppe: { zh: "草原风景淡彩", en: "Steppe field sketch", technique: "Use long lateral strokes and restrained earth and grass pigments for the visible rolling steppe." },
};
const styles = [
  [/克孜尔(?:千佛洞|石窟)|Kizil (?:Caves|Grottoes)/i, techniques.kucha],
  [/布达拉宫|大昭寺|Potala Palace|Jokhang/i, techniques.tibetanArchitecture],
  [/古罗马广场|罗马斗兽场|罗马竞技场|Roman Forum|Colosseum/i, techniques.romanAntiquity],
  [/圣彼得大教堂|圣伯多禄大殿|St\.? Peter.s Basilica|西斯廷礼拜堂|Sistine Chapel/i, techniques.renaissance],
  [/西湖|桂林山水|漓江|黄山风景区|Huangshan|Hangzhou West Lake|Guilin|Li River/i, techniques.landscapeInk],
  [/呼伦贝尔(?:大)?草原|锡林郭勒(?:大)?草原|Hulunbuir (?:grassland|steppe)|Xilin Gol (?:grassland|steppe)/i, techniques.steppe],
];
export function destinationPaintingStyle(node) {
  const title = String(node?.title ?? "").trim();
  // A museum exhibition, replica or a hotel named after a landmark is not that landmark.
  if (node?.domain !== "play" || /酒店|宾馆|复制品|主题乐园|展览|特展|replica|hotel|exhibition/i.test(title)) return penWash;
  const placeStyle = styles.find(([match]) => match.test(title))?.[1];
  if (placeStyle) return placeStyle;
  const location = [node.location?.city, node.location?.province, node.location?.label, node.location?.address, title].filter(Boolean).join(" ");
  const clues = [title, node.category, node.operability?.category, node.evidenceSummary?.headline, node.summary].filter(Boolean).join(" ");
  if (/罗马|梵蒂冈|\bRome\b|Vatican/i.test(location) && /文艺复兴|Renaissance/i.test(clues) && /教堂|大殿|礼拜堂|basilica|church|chapel/i.test(clues)) return techniques.renaissance;
  if (/新疆|库车|Xinjiang|Kuqa/i.test(location) && /龟兹壁画|Kucha murals?/i.test(clues)) return techniques.kucha;
  if (/西藏|拉萨|Tibet|Lhasa/i.test(location) && /藏式建筑|藏式宫殿|Tibetan (?:architecture|palace)/i.test(clues)) return techniques.tibetanArchitecture;
  if (/内蒙古|Inner Mongolia/i.test(location) && /草原|grassland|steppe/i.test(clues)) return techniques.steppe;
  if (/山水画|山水画派|shanshui/i.test(clues) && /山|江|湖|mountain|river|lake/i.test(title)) return techniques.landscapeInk;
  return penWash;
}

export function paintingInstructions(style) {
  return [
    "Edit only the attached photograph into a finished hand-drawn travel illustration. Match its framing, landmarks, building geometry, people, terrain and viewpoint.",
    style.technique, "Keep the line hierarchy, spatial perspective and light/shadow legible. Use the style as a drawing technique only. No invented figures, ethnic motifs, religious symbols, text, borders or replacement scenery.",
  ].join(" ");
}

export function validDepthShapes(shapes) {
  if (!Array.isArray(shapes) || !shapes.length || shapes.length > 24) return false;
  let total = 0;
  for (const s of shapes) {
    if (![1,2,3,4].includes(s?.depth) || !Array.isArray(s.points) || s.points.length < 3 || s.points.length > 160 ||
        !s.points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1))) return false;
    total += s.points.length;
    const twiceArea = s.points.reduce((area, [x,y], i) => {
      const [nx,ny] = s.points[(i+1)%s.points.length];
      return area + x*ny - nx*y;
    }, 0);
    if (Math.abs(twiceArea) < .00005) return false;
  }
  return total <= 800;
}

export const depthInstructions = 'Inspect the finished drawing. Trace the visible silhouettes that create parallax as polygons in normalized [x,y] image coordinates, top left [0,0]. Assign depth 1 to distant terrain/landmarks, 2 to middle terrain and roofs, 3 to near banks, 4 to close objects. Uncovered pixels remain distant. Include islands and partial frame-edge foregrounds. Follow each silhouette with enough vertices, including tall slender landmarks. Preserve the whole painting. Supply at least two meaningful depth planes where the scene permits, never generic horizontal bands.';
