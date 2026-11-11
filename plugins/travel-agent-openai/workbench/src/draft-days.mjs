/** Keep visits in actual-time order, while allowing a local date to recur after a time-zone crossing. */
export function draftDays(stops) {
  const ordered = stops.map((stop, index) => ({ stop, index, time: Date.parse(stop?.startAt) }));
  ordered.sort((a, b) => {
    const left = Number.isFinite(a.time), right = Number.isFinite(b.time);
    if (left !== right) return left ? -1 : 1;
    return left ? a.time - b.time || a.index - b.index : a.index - b.index;
  });
  const groups = [];
  for (const { stop } of ordered) {
    const date = typeof stop?.startLocal === "string" ? stop.startLocal.slice(0, 10) : "日期待确定";
    let group = groups[groups.length - 1];
    if (!group || group.date !== date) { group = { date, stops: [] }; groups.push(group); }
    group.stops.push(stop);
  }
  return groups;
}
