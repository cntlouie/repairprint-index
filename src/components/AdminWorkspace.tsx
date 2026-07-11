"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

interface QueueItem {
  id: string;
  kind: string;
  status: string;
  matchedEntityId: string | null;
  payload: Record<string, unknown>;
}

interface Target {
  productComponentId: string;
  modelPublicId: string;
  modelName: string;
  modelSlug: string;
  brandName: string;
  componentName: string;
  oemPartNumber: string | null;
}

interface QueueData {
  submissions: QueueItem[];
  targets: Target[];
  collisions: Array<{ id: string; type: string; key: string; conflictingKeys: string[] }>;
  catalog: {
    brands: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
    components: Array<{ id: string; name: string; categoryId: string }>;
    sources: Array<{ id: string; title: string; url: string }>;
  };
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { blockers?: string[] } };
}

interface Enrollment {
  id: string;
  qrCode: string;
  secret: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function AdminWorkspace() {
  const supabase = useMemo(
    () => supabaseUrl && publishableKey ? createClient(supabaseUrl, publishableKey, { auth: { flowType: "pkce", persistSession: true } }) : null,
    [],
  );
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [aal, setAal] = useState<string>("signed_out");
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshAssurance = useCallback(async (client: SupabaseClient) => {
    const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data?.currentLevel ?? "aal1");
    const factors = await client.auth.mfa.listFactors();
    const verified = factors.data?.totp.find((factor) => factor.status === "verified");
    setFactorId(verified?.id ?? null);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void refreshAssurance(supabase);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) void refreshAssurance(supabase);
      else setAal("signed_out");
    });
    return () => data.subscription.unsubscribe();
  }, [refreshAssurance, supabase]);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    if (!session?.access_token) throw new Error("Sign in first.");
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        "X-Request-Id": `req_admin_${crypto.randomUUID()}`,
        ...init?.headers,
      },
      cache: "no-store",
    });
    const body = await response.json() as ApiErrorBody & Record<string, unknown>;
    if (!response.ok) {
      const blockers = body.error?.details?.blockers?.join(" ");
      throw new Error([body.error?.code, body.error?.message, blockers].filter(Boolean).join(": "));
    }
    return body;
  }, [session]);

  const loadQueue = useCallback(async () => {
    if (!session) return;
    try {
      const data = await api("/api/admin/queue") as unknown as QueueData;
      setQueue(data);
      setSelectedId((current) => current ?? data.submissions[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Queue could not be loaded.");
    }
  }, [api, session]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void api("/api/admin/queue")
      .then((result) => {
        if (!active) return;
        const data = result as unknown as QueueData;
        setQueue(data);
        setSelectedId((current) => current ?? data.submissions[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "Queue could not be loaded.");
      });
    return () => { active = false; };
  }, [api, session]);

  const selected = queue?.submissions.find((item) => item.id === selectedId) ?? null;
  const previewRecord = preview?.record && typeof preview.record === "object" ? preview.record as { fitmentId?: string } : null;
  const previewEvidence = Array.isArray(preview?.evidence) ? preview.evidence as Array<{ id: string; summary: string; moderationStatus: string }> : [];

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(success);
      await loadQueue();
      if (selectedId) setPreview(await api(`/api/admin/cases/${selectedId}/preview`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!supabase) {
    return <section className="admin-panel"><h2>Configuration required</h2><p>Set the browser-safe Supabase URL and publishable key. Service-role credentials are never used here.</p></section>;
  }

  if (!session) {
    return (
      <form className="admin-panel admin-login" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void supabase.auth.signInWithPassword({ email, password }).then(({ error }) => {
          setMessage(error?.message ?? "Signed in.");
          setBusy(false);
        });
      }}>
        <h2>Invite-only sign in</h2>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="button-primary" disabled={busy}>Sign in</button>
        {message && <p role="status">{message}</p>}
      </form>
    );
  }

  async function verifyTotp() {
    if (!supabase) throw new Error("Supabase Auth is not configured.");
    if (!factorId) throw new Error("Enroll an authenticator first.");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: totpCode });
    if (error) throw error;
    setTotpCode("");
    setEnrollment(null);
    await refreshAssurance(supabase);
  }

  async function updatePassword() {
    if (!supabase) throw new Error("Supabase Auth is not configured.");
    if (newPassword.length < 12) throw new Error("Use at least 12 characters for the password.");
    if (newPassword !== confirmPassword) throw new Error("The password confirmation does not match.");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <div className="admin-workspace">
      <aside className="admin-sidebar admin-panel">
        <div className="admin-session">
          <strong>{session.user.email}</strong>
          <span>Assurance: {aal}</span>
          <button onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </div>
        <form className="mfa-box" onSubmit={(event) => {
          event.preventDefault();
          void run(updatePassword, "Account password updated.");
        }}>
          <h3>Set or change password</h3>
          <p>Invited staff should set a password here before ending the invitation session.</p>
          <label>New password<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
          <label>Confirm password<input type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
          <button disabled={busy}>Save password</button>
        </form>
        {aal !== "aal2" && (
          <div className="mfa-box">
            <h3>Authenticator verification</h3>
            {!factorId && <button onClick={() => void supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "RepairPrint staff" }).then(({ data, error }) => {
              if (error) setMessage(error.message);
              if (data) {
                setFactorId(data.id);
                setEnrollment({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
              }
            })}>Enroll authenticator</button>}
            {enrollment && (
              <div className="mfa-enrollment">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={enrollment.qrCode} alt="Authenticator enrollment QR code" />
                <code>{enrollment.secret}</code>
              </div>
            )}
            {factorId && <><label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} /></label><button onClick={() => void run(verifyTotp, "Authenticator verified.")}>Verify</button></>}
          </div>
        )}
        <h2>Editorial queue</h2>
        <button onClick={() => void loadQueue()}>Refresh queue</button>
        <ul className="admin-queue-list">
          {queue?.submissions.map((item) => (
            <li key={item.id}><button className={item.id === selectedId ? "selected" : ""} onClick={() => { setSelectedId(item.id); setPreview(null); }}>{String(item.payload.sourceUrl ?? item.kind)}<span>{item.status}</span></button></li>
          ))}
        </ul>
        {queue?.collisions.length ? <><h3>Entity collisions</h3><ul>{queue.collisions.map((collision) => <li key={collision.id}>{collision.type}: {collision.key}</li>)}</ul></> : null}
      </aside>

      <section className="admin-main admin-panel">
        {queue && <CatalogDraftForm catalog={queue.catalog} busy={busy} onSubmit={(body) => run(() => api("/api/admin/catalog/targets", { method: "POST", body: JSON.stringify(body) }), "Exact model/component/OEM draft saved with pending citations.")} />}
        {!selected ? <p>No queued submission selected.</p> : (
          <>
            <div className="admin-case-heading"><div><p className="eyebrow">{selected.kind}</p><h2>{String(selected.payload.sourceUrl ?? "Queued submission")}</h2></div><span className="status-pill">{selected.status}</span></div>
            <dl className="claim-grid">
              {Object.entries(selected.payload).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value || "—")}</dd></div>)}
            </dl>
            {selected.status === "pending" && <PrepareCaseForm item={selected} targets={queue?.targets ?? []} busy={busy} onSubmit={(body) => run(() => api(`/api/admin/cases/${selected.id}/prepare`, { method: "POST", body: JSON.stringify(body) }), "Draft case prepared for independent review.")} />}
            {selected.status === "in_review" && <ReviewCaseForm busy={busy} onDecision={(decision, body) => run(() => api(`/api/admin/cases/${selected.id}/review`, { method: "POST", body: JSON.stringify({ ...body, decision }) }), decision === "accept" ? "Case accepted for publication review." : "Case rejected and retained in history.")} />}
            {selected.status === "accepted" && <PublicationForm busy={busy} onPublish={(body) => run(() => api(`/api/admin/cases/${selected.id}/publish`, { method: "POST", body: JSON.stringify(body) }), "Publication transaction passed every gate.")} />}
            {selected.matchedEntityId && <button onClick={() => void run(async () => setPreview(await api(`/api/admin/cases/${selected.id}/preview`)), "Preview refreshed.")}>Refresh sourced preview</button>}
            {preview && <pre className="admin-preview">{JSON.stringify(preview, null, 2)}</pre>}
            {previewEvidence.map((evidence) => <div className="admin-evidence-row" key={evidence.id}><span>{evidence.summary} — {evidence.moderationStatus}</span><div className="button-row"><button disabled={busy} onClick={() => void run(() => api(`/api/admin/evidence/${evidence.id}`, { method: "POST", body: JSON.stringify({ decision: "accepted", reason: "Accepted after source-side evidence review.", requestId: `req_evidence_${crypto.randomUUID()}` }) }), "Evidence accepted and fitment recomputed.")}>Accept evidence</button><button disabled={busy} onClick={() => void run(() => api(`/api/admin/evidence/${evidence.id}`, { method: "POST", body: JSON.stringify({ decision: "rejected", reason: "Rejected after source-side evidence review.", requestId: `req_evidence_${crypto.randomUUID()}` }) }), "Evidence rejected and fitment recomputed.")}>Reject evidence</button></div></div>)}
            {previewRecord?.fitmentId && <ArchiveForm fitmentId={previewRecord.fitmentId} busy={busy} onArchive={(body) => run(() => api(`/api/admin/fitments/${previewRecord.fitmentId}/archive`, { method: "POST", body: JSON.stringify(body) }), "Fitment archived with redirect; evidence and audit history retained.")} />}
          </>
        )}
        {message && <p className="admin-message" role="status">{message}</p>}
      </section>
    </div>
  );
}

function CatalogDraftForm({ catalog, busy, onSubmit }: { catalog: QueueData["catalog"]; busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [categoryId, setCategoryId] = useState(catalog.categories[0]?.id ?? "");
  const [componentMode, setComponentMode] = useState<"existing" | "new">("existing");
  const [oemMode, setOemMode] = useState<"none" | "new">("none");
  const eligibleComponents = catalog.components.filter((component) => component.categoryId === categoryId);

  return <details className="admin-form admin-catalog-editor">
    <summary><strong>Create exact model/component/OEM draft</strong><span>Draft only; source review is still required.</span></summary>
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const component = componentMode === "existing" ? { mode: "existing", id: data.get("componentId") } : { mode: "new", name: data.get("componentName"), slug: data.get("componentSlug"), commonNames: csv(data.get("componentCommonNames")) };
      const oem = oemMode === "none" ? { mode: "none" } : { mode: "new", publicId: data.get("oemPublicId"), partNumberDisplay: data.get("oemPartNumber"), name: data.get("oemName") };
      void onSubmit({ brandId: data.get("brandId"), categoryId, sourceId: data.get("sourceId"), sourceLocator: data.get("sourceLocator"), modelPublicId: data.get("modelPublicId"), modelName: data.get("modelName"), modelSlug: data.get("modelSlug"), marketCodes: csv(data.get("marketCodes")), identifierDisplay: data.get("identifierDisplay"), identifierType: data.get("identifierType"), component, oem, reason: data.get("reason"), requestId: `req_catalog_${crypto.randomUUID()}` });
    }}>
      <div className="admin-form-grid">
        <label>Brand<select name="brandId" required>{catalog.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
        <label>Category<select name="categoryId" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>{catalog.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label>Reviewed source<select name="sourceId" required>{catalog.sources.map((source) => <option key={source.id} value={source.id}>{source.title} — {source.url}</option>)}</select></label>
        <label>Source locator<input name="sourceLocator" placeholder="Manual section, page, or listing field" required /></label>
        <label>Model public ID<input name="modelPublicId" required /></label><label>Exact model name<input name="modelName" required /></label>
        <label>Model slug<input name="modelSlug" required /></label><label>Market/region codes<input name="marketCodes" placeholder="IS, EU" required /></label>
        <label>Identifier display value<input name="identifierDisplay" required /></label><label>Identifier type<input name="identifierType" defaultValue="model_number" required /></label>
      </div>
      <fieldset><legend>Component</legend>
        <label className="checkbox-row"><input type="radio" checked={componentMode === "existing"} onChange={() => setComponentMode("existing")} /> Existing exact component</label><label className="checkbox-row"><input type="radio" checked={componentMode === "new"} onChange={() => setComponentMode("new")} /> New component draft</label>
        {componentMode === "existing" ? <label>Component<select name="componentId" required>{eligibleComponents.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}</select></label> : <div className="admin-form-grid"><label>Name<input name="componentName" required /></label><label>Slug<input name="componentSlug" required /></label><label>Common names<input name="componentCommonNames" placeholder="comma, separated" /></label></div>}
      </fieldset>
      <fieldset><legend>OEM reference</legend>
        <label className="checkbox-row"><input type="radio" checked={oemMode === "none"} onChange={() => setOemMode("none")} /> No OEM reference</label><label className="checkbox-row"><input type="radio" checked={oemMode === "new"} onChange={() => setOemMode("new")} /> New OEM draft</label>
        {oemMode === "new" && <div className="admin-form-grid"><label>OEM public ID<input name="oemPublicId" required /></label><label>Part number display<input name="oemPartNumber" required /></label><label>OEM part name<input name="oemName" required /></label></div>}
      </fieldset>
      <label>Preparation reason<textarea name="reason" defaultValue="Prepared exact catalog target from a reviewed source; publication remains blocked pending independent review." required /></label>
      <button className="button-primary" disabled={busy || (componentMode === "existing" && !eligibleComponents.length)}>Save catalog draft</button>
    </form>
  </details>;
}

function PrepareCaseForm({ item, targets, busy, onSubmit }: { item: QueueItem; targets: Target[]; busy: boolean; onSubmit: (body: Record<string, unknown>) => Promise<unknown> }) {
  const payload = item.payload;
  const sourceUrl = String(payload.sourceUrl ?? "");
  const hostname = safeHostname(sourceUrl);
  const [target, setTarget] = useState(targets[0]?.productComponentId ?? "");
  const [reason, setReason] = useState("Prepared from the private creator submission with exact target confirmed.");
  return (
    <form className="admin-form" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void onSubmit({
        productComponentId: target,
        confirmExactTarget: data.get("confirmExactTarget") === "on",
        designTitle: data.get("designTitle"),
        creatorPlatform: data.get("creatorPlatform"),
        sourcePlatform: data.get("sourcePlatform"),
        sourceExternalId: data.get("sourceExternalId"),
        sourceRevision: data.get("sourceRevision"),
        sourceTitle: data.get("sourceTitle"),
        licenseCode: data.get("licenseCode"),
        licenseVersion: data.get("licenseVersion"),
        licenseUrl: data.get("licenseUrl"),
        licenseEvidenceUrl: data.get("licenseEvidenceUrl"),
        attributionText: data.get("attributionText"),
        fileFormats: String(data.get("fileFormats") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
        observedAt: data.get("observedAt"),
        evidenceSummary: data.get("evidenceSummary"),
        reason,
        requestId: `req_prepare_${crypto.randomUUID()}`,
      });
    }}>
      <h3>Prepare source, target, revision, rights, fitment and evidence</h3>
      <label>Exact product component<select value={target} onChange={(event) => setTarget(event.target.value)} required>{targets.map((option) => <option value={option.productComponentId} key={option.productComponentId}>{option.brandName} {option.modelName} — {option.componentName}{option.oemPartNumber ? ` — OEM ${option.oemPartNumber}` : ""}</option>)}</select></label>
      <label className="checkbox-row"><input name="confirmExactTarget" type="checkbox" required /> I checked the exact model label, suffix/region and component.</label>
      <div className="admin-form-grid">
        <label>Design title<input name="designTitle" defaultValue={`${String(payload.modelNumber ?? "")} ${String(payload.componentName ?? "")}`} required /></label>
        <label>Creator platform<input name="creatorPlatform" defaultValue={hostname} required /></label>
        <label>Source platform<input name="sourcePlatform" defaultValue={hostname} required /></label>
        <label>External source ID<input name="sourceExternalId" required /></label>
        <label>Source revision<input name="sourceRevision" defaultValue="r1" required /></label>
        <label>Source title<input name="sourceTitle" defaultValue={`${String(payload.creatorName ?? "Creator")} listing`} required /></label>
        <label>Licence code<input name="licenseCode" defaultValue={String(payload.claimedLicense ?? "NOT-STATED")} required /></label>
        <label>Licence version<input name="licenseVersion" /></label>
        <label>Licence URL<input name="licenseUrl" type="url" /></label>
        <label>Licence evidence URL<input name="licenseEvidenceUrl" type="url" defaultValue={sourceUrl} /></label>
        <label>File formats metadata<input name="fileFormats" defaultValue="STL" required /></label>
        <label>Claim observation date<input name="observedAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
      </div>
      <label>Attribution text<input name="attributionText" defaultValue={`${String(payload.componentName ?? "Design")} by ${String(payload.creatorName ?? "creator")}`} required /></label>
      <label>Evidence summary<textarea name="evidenceSummary" defaultValue={`Creator claims compatibility with exact model ${String(payload.modelNumber ?? "")}; not independently verified.`} required /></label>
      <label>Preparation reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required /></label>
      <button className="button-primary" disabled={busy || !target}>Save draft and send to review</button>
    </form>
  );
}

function ReviewCaseForm({ busy, onDecision }: { busy: boolean; onDecision: (decision: "accept" | "reject", body: Record<string, unknown>) => Promise<unknown> }) {
  const [reason, setReason] = useState("Reviewed source, exact target, rights, evidence and independent safety classification.");
  const body = () => ({ safetyClass: "low", safetySignals: ["low_load_clip"], safetyRationale: "Low-load external part; failure causes inconvenience only.", reason, requestId: `req_review_${crypto.randomUUID()}` });
  return <div className="admin-form"><h3>Independent rights, evidence and safety decision</h3><p>The source and every material claim are shown in the preview below. Reviewer/admin actions require AAL2.</p><label>Decision reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="button-row"><button className="button-primary" disabled={busy} onClick={() => void onDecision("accept", body())}>Accept for publication review</button><button disabled={busy} onClick={() => void onDecision("reject", { ...body(), reason: `Rejected: ${reason}` })}>Reject and retain</button></div></div>;
}

function PublicationForm({ busy, onPublish }: { busy: boolean; onPublish: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [reason, setReason] = useState("Publication gates rechecked after independent editorial approval.");
  return <div className="admin-form"><h3>Publication transaction</h3><p>This re-checks source policy and health, creator/rights, exact target, accepted provenance, safety class, disputes and active rulesets.</p><label>Publication reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="button-primary" disabled={busy} onClick={() => void onPublish({ reason, requestId: `req_publish_${crypto.randomUUID()}` })}>Publish reviewed record</button></div>;
}

function ArchiveForm({ fitmentId, busy, onArchive }: { fitmentId: string; busy: boolean; onArchive: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [replacementPath, setReplacementPath] = useState("/");
  const [reason, setReason] = useState("Archive record while retaining evidence, audit history and one-hop redirect.");
  return <div className="admin-form"><h3>Archive and redirect</h3><p>Admin only. Fitment {fitmentId}</p><label>Internal replacement path<input value={replacementPath} onChange={(event) => setReplacementPath(event.target.value)} /></label><label>Archive reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} onClick={() => void onArchive({ replacementPath, reason, requestId: `req_archive_${crypto.randomUUID()}` })}>Archive record</button></div>;
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "manual-submission";
  }
}

function csv(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
