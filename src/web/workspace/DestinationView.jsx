import { DestinationExperience } from "./DestinationExperience.jsx";
export const destinationLocation = node => ({ place: { sourceId: node.nodeId, name: node.title, type: node.operability?.category ?? node.domain, coordinates: node.location?.coordinates, sourceLabel: node.operability?.sourceLabel }, domain: node.domain, checkedAt: node.operability?.checkedAt });
export function DestinationView({ node, plan, onClose, onJournal, canEdit = true }) {
  if (node.operability?.contentRefreshRequired || ["stale", "expired"].includes(node.sourceStatus)) return <section className="media-empty"><h2>地点资料需要重新读取</h2><p>当前地点参考资料已失效，暂不据此打开场景。已保存的行程和旅行记录仍然保留。</p><button type="button" className="ui-secondary" onClick={onClose}>返回地点</button></section>;
  const locations = Object.values(plan?.byDomain ?? {}).flat().filter(item => item.title && !item.operability?.contentRefreshRequired && !["stale", "expired"].includes(item.sourceStatus)).map(destinationLocation);
  return <DestinationExperience {...destinationLocation(node)} locations={locations} onClose={onClose} onJournal={onJournal} canEdit={canEdit} />;
}
