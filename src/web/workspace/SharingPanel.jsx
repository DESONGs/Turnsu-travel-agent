import { useEffect, useRef, useState } from "react";
import { normalizeShareEmail, shareEmailDigest } from "./share-email.mjs";
import { Sheet, ConfirmInline } from "./Sheet.jsx";
import { Icon } from "./Icon.jsx";
import "./media-workspace.css";

const identity = member => member.name || member.email || "共享账号";
const roleLabel = role => role === "editor" ? "可编辑" : "仅查看";

export function SharingPanel({ tripId, host, onClose, tripTitle = "这趟旅行" }) {
  const [members, setMembers] = useState([]), [cursor, setCursor] = useState(null), [accessRevision, setAccessRevision] = useState(null);
  const [step, setStep] = useState("members"), [email, setEmail] = useState(""), [role, setRole] = useState("viewer");
  const [candidate, setCandidate] = useState(null), [decision, setDecision] = useState(null);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true), [listFailed, setListFailed] = useState(false), [uncertain, setUncertain] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const pendingWrite = useRef(null), alive = useRef(true), readId = useRef(0), title = useRef(null);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; readId.current++; }; }, [tripId]);
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, [step]);
  async function load(append = false) {
    const id = ++readId.current; setLoading(true); setListFailed(false);
    try { const value = await host.call("list_trip_share_members", { tripId, ...(append && cursor ? { cursor } : {}) });
      if (!Array.isArray(value.items) || !Number.isSafeInteger(value.accessRevision)) throw new Error("共享列表暂时无法读取。");
      if (alive.current && id === readId.current) { setMembers(previous => append ? [...previous, ...value.items] : value.items); setCursor(value.nextCursor || null); setAccessRevision(value.accessRevision); }
    } catch (failure) { if (alive.current && id === readId.current) { setListFailed(true); setError(failure.message || "共享列表暂时无法读取，请重试。"); } }
    finally { if (alive.current && id === readId.current) setLoading(false); }
  }
  async function find(event) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null); setCandidate(null);
    try { const normalized = normalizeShareEmail(email), emailHash = await shareEmailDigest(normalized);
      const result = await host.call("resolve_trip_share_email", { tripId, emailHash });
      if (alive.current) { setCandidate({ ...result, email: normalized, emailHash, role }); setStep("confirm"); }
    } catch (failure) { if (alive.current) setError(failure.message || "账号查找未完成，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (busy) return;
    if (!pendingWrite.current) {
      const target = step === "confirm" ? candidate : decision?.member;
      if (!target || accessRevision == null) return;
      const tool = step === "confirm" ? "grant_trip_share_email" : step === "revoke" ? "revoke_trip_access" : "grant_trip_access";
      const desiredRole = step === "confirm" ? candidate.role : decision?.role;
      pendingWrite.current = { tool, desiredRole, args: { tripId, accountId: target.accountId, expectedAccessRevision: step === "confirm" ? candidate.accessRevision : accessRevision,
        requestId: crypto.randomUUID(), ...(step === "revoke" ? {} : { role: desiredRole }), ...(step === "confirm" ? { emailHash: candidate.emailHash } : {}) } };
    }
    const command = pendingWrite.current; readId.current++; setBusy(true); setError(null); setNotice(null);
    try { const result = await host.call(command.tool, command.args); if (!alive.current) return;
      const done = command.tool === "revoke_trip_access" ? result.revoked === true : result.role === command.desiredRole;
      setNotice(done ? command.tool === "revoke_trip_access" ? "已撤销访问；对方不能继续打开这趟旅行与照片。" : "共享权限已保存。" : "共享状态随后有变化，请查看当前成员与权限。");
      pendingWrite.current = null; setUncertain(false); setCandidate(null); setDecision(null); setStep("members"); setEmail(""); await load();
    } catch (failure) { if (alive.current) { if (failure.code) { pendingWrite.current = null; setUncertain(false); if (failure.code === "access_revision_conflict") { setStep("members"); await load(); } else if (failure.code === "share_account_changed") { setCandidate(null); setStep("find"); } }
      else setUncertain(true); setError(failure.message || "共享结果尚未确认。按原操作重试，或返回后重新读取列表核对。"); } }
    finally { if (alive.current) setBusy(false); }
  }
  function close() { if (uncertain) setConfirmClose(true); else onClose(); }
  function back() { if (busy || uncertain) return; setError(null); setCandidate(null); setDecision(null); setStep("members"); }
  const target = step === "confirm" ? candidate : decision?.member;
  const desiredRole = step === "confirm" ? candidate?.role : decision?.role;
  const deciding = ["confirm", "role", "revoke"].includes(step);
  return <Sheet title="共享旅行" context={tripTitle} onClose={close} busy={busy} footer={deciding && <>
    <p>{uncertain ? "结果尚未确认，不会自动重复提交" : step === "revoke" ? "确认后停止此账号的后续访问" : "只对上面核对过的账号生效"}</p><div className="ui-actions"><button className="ui-secondary" type="button" disabled={busy || uncertain} onClick={back}>取消</button><button className={step === "revoke" ? "ui-danger" : "ui-primary"} type="button" disabled={busy || !target} onClick={save}>{busy ? "正在保存…" : uncertain ? "重试原次操作" : step === "revoke" ? "确认撤销访问" : step === "role" ? "保存权限变更" : "确认共享"}</button></div>
  </>}>
    {confirmClose && <ConfirmInline title="共享结果尚未确认" description="关闭后请先重新读取成员列表核对，不要直接重复授权。不会发送邀请邮件或自动重试。" cancel="继续核对" action="关闭并稍后检查" onCancel={() => setConfirmClose(false)} onConfirm={onClose} />}
    {notice && <p className="ui-success" role="status"><Icon name="CheckCircle" />{notice}</p>}{error && <p className="ui-error" role="alert">{error}</p>}
    {step === "members" ? <>
      <section className="sharing-owner"><Icon name="Lock" /><div><strong>你是旅行拥有者</strong><p>只有你可以添加同行人、更改权限或撤销访问。</p></div></section>
      <div className="sharing-scope"><h3>共享后，对方能看到什么？</h3><p>这趟旅行的行程、手账、照片和已保存的浮雕效果一起共享。不会因此获得你其他旅行的权限。</p></div>
      <div className="sharing-members-heading"><h3>可访问的同行人</h3><button className="ui-text" type="button" disabled={loading || busy} onClick={() => { setError(null); load(); }}><Icon name="ArrowCounterClockwise" />刷新</button></div>
      {loading && !members.length ? <p className="ui-help" role="status">正在读取共享成员…</p> : listFailed && !members.length ? <div className="sharing-empty"><p>成员列表暂时无法读取，已保存的授权保持原样。</p><button className="ui-secondary" type="button" onClick={() => load()}>重新读取成员</button></div> : members.length ? <ul className="sharing-people">{members.map(member => <li key={member.accountId}><div className="sharing-person"><span className="sharing-avatar"><Icon name="Users" /></span><div><strong>{identity(member)}</strong>{member.email && member.name && <p>{member.email}</p>}<span className={`sharing-role ${member.role}`}>{roleLabel(member.role)}</span></div></div><div className="sharing-person-actions"><button className="ui-text" type="button" disabled={busy || accessRevision === null} onClick={() => { setDecision({ member, role: member.role === "editor" ? "viewer" : "editor" }); setStep("role"); setError(null); setNotice(null); }}>更改权限</button><button className="ui-text ui-danger-text" type="button" disabled={busy || accessRevision === null} onClick={() => { setDecision({ member }); setStep("revoke"); setError(null); setNotice(null); }}>撤销访问</button></div></li>)}</ul> : <div className="sharing-empty"><Icon name="Users" /><h3>目前只有你能访问</h3><p>添加已注册的同行人，一起查看或整理这趟旅行。</p></div>}
      {cursor && <button className="ui-secondary" type="button" disabled={busy || loading} onClick={() => load(true)}>继续查看其他成员</button>}
      <button className="ui-primary sharing-add" type="button" disabled={busy || loading || listFailed} onClick={() => { setStep("find"); setError(null); setNotice(null); }}><Icon name="Plus" />添加同行人</button>
      <p className="ui-help">聊天转发和入口文件不会自动授予访问权限。对方需以获授权的 Google 账号打开旅行。</p>
    </> : step === "find" ? <>
      <button className="ui-text" type="button" onClick={back} disabled={busy}><Icon name="ArrowLeft" />返回成员列表</button><h3 className="sharing-step-title" ref={title} tabIndex={-1}>先找到对方的账号</h3><p className="sharing-intro">输入对方用于 Google 登录的邮箱。找到后，还会让你核对账号和权限。</p>
      <form className="sharing-new-form" onSubmit={find}><label className="ui-field">Google 登录邮箱<input type="email" autoComplete="off" required disabled={busy} value={email} placeholder="name@example.com" onInput={event => setEmail(event.currentTarget.value)} /></label>
        <fieldset className="sharing-permission-options" disabled={busy}><legend>允许对方做什么？</legend>{["viewer", "editor"].map(value => <label className={role === value ? "selected" : ""} key={value}><input type="radio" name="sharing-role" value={value} checked={role === value} onChange={() => setRole(value)} /><div><strong>{roleLabel(value)}</strong><p>{value === "viewer" ? "可看行程、手账和照片，不能修改或删除。" : "可修改行程与手账，也可删除旅行记录和照片；不能管理共享。"}</p></div></label>)}</fieldset>
        <button className="ui-primary" type="submit" disabled={busy}>{busy ? "正在查找…" : "查找已注册账号"}<Icon name="ArrowRight" /></button><p className="ui-help">未注册时，请让对方先使用该邮箱登录。本页不会发送邀请邮件。</p>
      </form>
    </> : target && <>
      <h3 className="sharing-step-title" ref={title} tabIndex={-1}>{step === "revoke" ? "撤销这个账号的访问" : step === "role" ? "核对权限变化" : "核对这个账号，再共享"}</h3>
      <div className="sharing-confirm-person"><span className="sharing-avatar"><Icon name="Users" /></span><div><strong>{identity(target)}</strong>{target.email && <p>{target.email}</p>}</div></div>
      {step === "confirm" && candidate.emailAuthoritative === false && <div className="sharing-account-note"><Icon name="Info" /><p>这不是 Google 托管的邮箱。请核对对方当前使用的 Google 账号，确认归属后再共享。</p></div>}
      <div className="sharing-impact"><h4>{step === "revoke" ? "确认后会怎样？" : step === "role" ? `${roleLabel(target.role)} → ${roleLabel(desiredRole)}` : `授予「${roleLabel(desiredRole)}」权限`}</h4><ul>{step === "revoke" ? <><li>对方不能继续打开这趟旅行、手账和照片。</li><li>相关后台写入会停止；已经下载的副本无法收回。</li><li>你的旅行与原有记录保持原样。</li></> : desiredRole === "editor" ? <><li>可查看和编辑这趟旅行的行程与手账。</li><li>可添加、修改或删除旅行记录和照片。</li><li>不能添加其他同行人或管理共享。</li></> : <><li>可查看这趟旅行、手账、照片和已保存的浮雕。</li><li>不能修改行程、保存效果或删除记录。</li></>}</ul></div>
      {step === "confirm" && <p className="ui-help">授权绑定这个账号。以后可以在成员列表更改或撤销。</p>}
    </>}
  </Sheet>;
}
