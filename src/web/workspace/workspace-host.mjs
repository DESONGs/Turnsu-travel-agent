import { api } from "../api-client.js";
const messages = {
  workspace_postgres_required: "云端旅行存储尚未配置，暂时无法保存记录。请连接已配置的旅行服务。",
  journal_revision_conflict: "记录已在其他窗口修改。当前编辑保留，请核对云端版本。",
  journal_entry_not_found: "这条记录已被删除或更新，请重新读取手账。当前编辑保留。",
  revision_conflict: "旅行已有更新，请先重新读取行程。手账编辑仍保留。",
  trip_access_denied: "这趟旅行的访问权限已被撤销，请返回旅行列表。",
  trip_read_only: "你目前只有查看权限，不能保存或删除。",
  trip_owner_required: "只有旅行拥有者可以管理共享。",
  share_account_unavailable: "未找到可确认的已注册 Google 账号，请核对邮箱并让对方先登录。",
  share_account_changed: "查找到的账号已有变化，请重新查找并核对对象。",
  access_revision_conflict: "共享列表已发生变化，请重新读取当前成员与权限。",
  journal_trip_limit: "这趟旅行已有 40 条记录，请先整理不需要的记录。",
  journal_visit_not_found: "关联到访已有变化，请核对地点后再保存，文字和照片仍保留。",
  review_preview_stale: "行程或来源已变化，请让助手重新核验；未受影响的确认会保留。",
};
export const workspaceHost = { async call(name, args) {
  try { return await api.workspaceAction(args.tripId, name, args); }
  catch (error) {
    if (["trip_access_denied", "trip_not_found"].includes(error.code) && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("travel:access-revoked", { detail: { tripId: args.tripId } }));
    if (messages[error.code]) error.message = messages[error.code];
    throw error;
  }
} };
