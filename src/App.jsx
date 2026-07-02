import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { api, setPassword } from "./api.js";
import {
  usd, fmtDate, parseAmount, parseDate, daysOverdue, bucketOf, tierFor,
  BUCKETS, TIER_TAG, buildTemplate, buildReminders, pickInvoiceForFilename,
} from "../lib/receivables.js";

const FIELDS = [
  { key: "client", label: "Client / payer", required: true },
  { key: "email", label: "Contact email", required: false },
  { key: "invoice_no", label: "Invoice no.", required: false },
  { key: "amount", label: "Amount outstanding", required: true },
  { key: "due_date", label: "Due date", required: true },
  { key: "status", label: "Status", required: false },
];

function guessMapping(headers) {
  const find = (tests) =>
    headers.find((h) => tests.some((t) => String(h).toLowerCase().includes(t))) || "";
  return {
    client: find(["client", "customer", "company", "payer", "bill to", "owner", "name"]),
    email: find(["email", "e-mail", "mail"]),
    invoice_no: find(["invoice no", "invoice #", "invoice", "inv", "ref", "number", "#"]),
    amount: find(["outstanding", "balance", "amount due", "amount", "total", "owed"]),
    due_date:
      headers.find((h) => { const s = String(h).toLowerCase(); return s.includes("due") && s.includes("date"); }) ||
      find(["due", "date"]),
    status: find(["status", "paid", "state", "stage"]),
  };
}

const COMPANY = "Xinos Construction Corp";

export default function App() {
  const [authed, setAuthed] = useState(false);
  return authed ? <Main /> : <Gate onAuth={() => setAuthed(true)} />;
}

/* ----------------------------- gate ----------------------------- */
function Gate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr("");
    setPassword(pw);
    try {
      await api.list(); // validates the password against the server
      onAuth();
    } catch (e) {
      setErr(e.message === "unauthorized" ? "Wrong password." : "Could not reach the server.");
    } finally { setBusy(false); }
  }
  return (
    <div className="wrap">
      <Style />
      <div className="bar"><div className="mark" /><div className="word">Receivables Runner<small>Weekly payment reminders</small></div></div>
      <div className="pad" style={{ maxWidth: 420 }}>
        <p className="eyebrow">Sign in</p>
        <h2 className="h">Enter the app password</h2>
        <p className="sub">Set by whoever deployed this. It guards every action that touches the database.</p>
        <input type="password" value={pw} placeholder="Password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div className="warn" style={{ marginTop: 12 }}>{err}</div>}
        <div style={{ height: 14 }} />
        <button className="btn" disabled={busy || !pw} onClick={submit}>{busy ? "Checking…" : "Continue"}</button>
      </div>
    </div>
  );
}

/* ----------------------------- main ----------------------------- */
function Main() {
  const [view, setView] = useState("receivables");
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try { const d = await api.list(); setInvoices(d.invoices || []); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="wrap">
      <Style />
      <div className="bar">
        <div className="mark" />
        <div className="word">Receivables Runner<small>Weekly payment reminders</small></div>
        <div className="tabs">
          <button className={view === "receivables" ? "tab on" : "tab"} onClick={() => setView("receivables")}>Receivables</button>
          <button className={view === "import" ? "tab on" : "tab"} onClick={() => setView("import")}>Import</button>
          <button className={view === "attach" ? "tab on" : "tab"} onClick={() => setView("attach")}>Attachments</button>
        </div>
      </div>
      <div className="pad">
        {flash && <div className="ok">{flash}</div>}
        {view === "import"
          ? <Import onDone={(n) => { setFlash(`Imported ${n} invoices.`); reload(); setView("receivables"); }} />
          : view === "attach"
          ? <Attachments invoices={invoices} reload={reload} />
          : <Receivables invoices={invoices} loading={loading} reload={reload} />}
      </div>
    </div>
  );
}

/* ----------------------------- import ----------------------------- */
function Import({ onDone }) {
  const [step, setStep] = useState("upload");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef(null);

  const read = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
      const first = aoa.findIndex((r) => r.some((c) => c !== "" && c != null));
      const head = (aoa[first] || []).map((h, i) => (h === "" || h == null ? `Column ${i + 1}` : String(h)));
      const body = aoa.slice(first + 1).filter((r) => r.some((c) => c !== "" && c != null));
      setHeaders(head); setRows(body); setMapping(guessMapping(head)); setStep("map");
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const reqMissing = FIELDS.filter((f) => f.required && !mapping[f.key]);

  async function save() {
    setBusy(true); setErr("");
    try {
      const ci = {}; FIELDS.forEach((f) => (ci[f.key] = headers.indexOf(mapping[f.key])));
      const payload = rows.map((r) => {
        const due = ci.due_date >= 0 ? parseDate(r[ci.due_date]) : null;
        return {
          client: ci.client >= 0 ? String(r[ci.client] ?? "") : "",
          email: ci.email >= 0 ? String(r[ci.email] ?? "") : "",
          invoice_no: ci.invoice_no >= 0 ? String(r[ci.invoice_no] ?? "") : "",
          amount: ci.amount >= 0 ? parseAmount(r[ci.amount]) : NaN,
          due_date: due ? due.toISOString().slice(0, 10) : null,
          status: ci.status >= 0 ? String(r[ci.status] ?? "") : "unpaid",
        };
      }).filter((r) => isFinite(r.amount));
      const d = await api.import(payload);
      onDone(d.imported);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (step === "upload") return (
    <>
      <p className="eyebrow">Import — step 1</p>
      <h2 className="h">Drop in the invoice tracker</h2>
      <p className="sub">Any .xlsx or .csv, any layout. You map the columns next. Re-importing updates existing invoices by invoice number instead of duplicating them.</p>
      <div className="drop" onClick={() => inputRef.current.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); read(e.dataTransfer.files[0]); }}>
        <div className="big">Click to choose a file, or drag it here</div>
        <div className="sm">.xlsx · .xls · .csv</div>
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
          onChange={(e) => read(e.target.files[0])} />
      </div>
    </>
  );

  return (
    <>
      <p className="eyebrow">Import — step 2</p>
      <h2 className="h">Map the columns</h2>
      <p className="sub">Required fields are marked <b style={{ color: "var(--oxblood)" }}>*</b>.</p>
      {err && <div className="warn">{err}</div>}
      <div className="card" style={{ padding: 4, maxWidth: 560 }}>
        <table className="map"><tbody>
          {FIELDS.map((f) => (
            <tr key={f.key}>
              <td className="lab">{f.label} {f.required && <span style={{ color: "var(--oxblood)" }}>*</span>}</td>
              <td>
                <select value={mapping[f.key] || ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                  <option value="">— not in sheet —</option>
                  {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div style={{ height: 14 }} />
      <p className="eyebrow">Preview</p>
      <div className="prev"><table>
        <thead><tr>{FIELDS.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 5).map((r, i) => (
            <tr key={i}>{FIELDS.map((f) => {
              const ci = headers.indexOf(mapping[f.key]); let v = ci >= 0 ? r[ci] : "";
              if (f.key === "amount") v = isFinite(parseAmount(v)) ? usd(parseAmount(v)) : String(v ?? "");
              if (f.key === "due_date") { const d = parseDate(v); v = d ? fmtDate(d) : String(v ?? ""); }
              return <td key={f.key}>{String(v ?? "")}</td>;
            })}</tr>
          ))}
        </tbody>
      </table></div>
      <div style={{ height: 16 }} />
      <div className="row">
        <button className="btn ghost" onClick={() => setStep("upload")}>← Back</button>
        <button className="btn" disabled={reqMissing.length > 0 || busy} onClick={save}>
          {busy ? "Saving…" : `Import ${rows.length} invoices →`}
        </button>
        {reqMissing.length > 0 && <span className="miss">Map {reqMissing.map((f) => f.label).join(", ")} first.</span>}
      </div>
    </>
  );
}

/* ----------------------------- receivables ----------------------------- */
function Receivables({ invoices, loading, reload }) {
  const [includeDueSoon, setIncludeDueSoon] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [aiBusy, setAiBusy] = useState(null);
  const [sender, setSender] = useState("");

  const unpaid = invoices.filter((r) => r.status !== "paid");
  const today = new Date();

  const tally = useMemo(() => {
    const t = {}; Object.keys(BUCKETS).forEach((k) => (t[k] = { count: 0, sum: 0 }));
    let total = 0;
    unpaid.forEach((r) => {
      const over = daysOverdue(parseDate(r.due_date), today);
      const b = bucketOf(over); const amt = parseAmount(r.amount);
      t[b].count++; t[b].sum += isFinite(amt) ? amt : 0; total += isFinite(amt) ? amt : 0;
    });
    return { t, total };
  }, [invoices]);

  const { groups } = useMemo(
    () => buildReminders(unpaid, { today, includeDueSoon }),
    [invoices, includeDueSoon]
  );

  // seed template drafts when groups change
  useEffect(() => {
    setDrafts((prev) => {
      const next = {};
      groups.forEach((g) => {
        next[g.email] = prev[g.email]?.edited ? prev[g.email] : {
          ...buildTemplate({ company: COMPANY, sender: sender || "Accounts Receivable", client: g.client, rows: g.rows, total: g.total, tier: g.tier }),
          edited: false, source: "template",
        };
      });
      return next;
    });
  }, [groups.map((g) => g.email + g.total + g.tier).join("|"), sender]);

  async function polish(g) {
    setAiBusy(g.email);
    try {
      const d = await api.draft({ company: COMPANY, sender: sender || "Accounts Receivable", client: g.client, rows: g.rows, total: g.total, tier: g.tier });
      setDrafts((p) => ({ ...p, [g.email]: { ...d, edited: false, source: "ai" } }));
    } catch { /* keep template */ } finally { setAiBusy(null); }
  }

  async function act(id, action) { await api.update(id, action); reload(); }

  if (loading) return <p className="sub">Loading receivables…</p>;
  if (invoices.length === 0) return (
    <>
      <p className="eyebrow">Receivables</p>
      <h2 className="h">No invoices yet</h2>
      <p className="sub">Head to Import and drop in your tracker to get started.</p>
    </>
  );

  return (
    <div className="review">
      <div className="rail">
        <div className="card stat" style={{ marginBottom: 16 }}>
          <p className="eyebrow" style={{ margin: 0 }}>Total outstanding</p>
          <div className="big num">{usd(tally.total)}</div>
          <div className="sm2">{unpaid.length} unpaid</div>
        </div>
        <div className="card stat">
          <p className="eyebrow" style={{ margin: "0 0 6px" }}>Aging</p>
          {Object.keys(BUCKETS).map((k) => tally.t[k].count > 0 && (
            <div className="agerow" key={k}>
              <span className="dot" style={{ background: BUCKETS[k].color }} />
              <span>{BUCKETS[k].label}</span><span className="c num">{usd(tally.t[k].sum)}</span>
            </div>
          ))}
        </div>
        <div className="card stat" style={{ marginTop: 16 }}>
          <label className="cfg">Reminder scope</label>
          <select value={includeDueSoon ? "y" : "n"} onChange={(e) => setIncludeDueSoon(e.target.value === "y")}>
            <option value="n">Overdue only</option>
            <option value="y">+ due within 7 days</option>
          </select>
          <div style={{ height: 12 }} />
          <label className="cfg">Sender name (drafts)</label>
          <input type="text" value={sender} placeholder="Your name" onChange={(e) => setSender(e.target.value)} />
        </div>
      </div>

      <div>
        <p className="eyebrow" style={{ marginTop: 4 }}>This week's reminders — {groups.length}</p>
        {groups.length === 0 && <div className="card stat">Nothing to send under the current scope.</div>}
        {groups.map((g) => {
          const d = drafts[g.email] || { subject: "", body: "" };
          const bucket = BUCKETS[bucketOf(g.maxOver)];
          return (
            <div className="card email" key={g.email}>
              <div className="top">
                <div><div className="who">{g.client}</div><div className="addr">{g.email}</div></div>
                <span className="stamp" style={{ borderColor: bucket.color, color: bucket.color }}>
                  {g.maxOver > 0 ? `${g.maxOver}d over` : "due soon"}
                </span>
              </div>
              <div className="row pills">
                <span className="pill">{TIER_TAG[g.tier]}</span>
                <span className="pill">{g.rows.length} inv</span>
                <span className="pill num">{usd(g.total)}</span>
                {d.source === "ai" && <span className="pill green">AI</span>}
              </div>
              <input type="text" value={d.subject} style={{ fontWeight: 700, marginBottom: 8 }}
                onChange={(e) => setDrafts((p) => ({ ...p, [g.email]: { ...p[g.email], subject: e.target.value, edited: true } }))} />
              <textarea className="bodybox" value={d.body}
                onChange={(e) => setDrafts((p) => ({ ...p, [g.email]: { ...p[g.email], body: e.target.value, edited: true } }))} />
              <div className="acts">
                <button className="btn ox sm" onClick={() => window.open(`mailto:${encodeURIComponent(g.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`, "_blank")}>Open in mail</button>
                <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(`Subject: ${d.subject}\n\n${d.body}`)}>Copy</button>
                <button className="btn ghost sm" onClick={() => polish(g)} disabled={aiBusy === g.email}>{aiBusy === g.email ? "Drafting…" : "Polish with AI"}</button>
              </div>
            </div>
          );
        })}

        <p className="eyebrow" style={{ marginTop: 26 }}>All unpaid invoices</p>
        <div className="prev"><table>
          <thead><tr><th>Client</th><th>Invoice</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {unpaid.map((r) => {
              const over = daysOverdue(parseDate(r.due_date), today);
              const bc = BUCKETS[bucketOf(over)];
              return (
                <tr key={r.id}>
                  <td>{r.client}{r.paused && <span className="pill" style={{ marginLeft: 6 }}>paused</span>}</td>
                  <td>{r.invoice_no || "—"}{r.attachment_name && <span className="pill" style={{ marginLeft: 6 }} title={r.attachment_name}>file</span>}</td>
                  <td className="num">{usd(parseAmount(r.amount))}</td>
                  <td className="num" style={{ color: bc.color }}>{fmtDate(parseDate(r.due_date))}{over > 0 ? ` (${over}d)` : ""}</td>
                  <td>{r.status}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="link" onClick={() => act(r.id, "paid")}>paid</button>
                    <button className="link" onClick={() => act(r.id, r.paused ? "unpause" : "pause")}>{r.paused ? "resume" : "mute"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

/* ----------------------------- attachments ----------------------------- */
function Attachments({ invoices, reload }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [errs, setErrs] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const invoiceNos = invoices.map((i) => i.invoice_no).filter(Boolean);
  const byNo = useMemo(() => {
    const m = {}; invoices.forEach((i) => { if (i.invoice_no) m[i.invoice_no] = i; }); return m;
  }, [invoices]);
  const attachedCount = invoices.filter((i) => i.attachment_name).length;

  // make the file picker read whole folders, including nested subfolders
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.setAttribute("webkitdirectory", "");
      inputRef.current.setAttribute("directory", "");
    }
  }, []);

  const isInvoiceFile = (name) => /\.(pdf|png|jpe?g)$/i.test(name);

  function onFiles(fileList) {
    const mapped = Array.from(fileList || [])
      .filter((file) => isInvoiceFile(file.name))
      .map((file) => {
        const matchNo = pickInvoiceForFilename(file.name, invoiceNos);
        return { file, matchNo, invoice: matchNo ? byNo[matchNo] : null };
      });
    setRows(mapped); setDone(0); setErrs([]);
  }

  // walk a dropped folder tree (all levels) and collect every file
  async function walkEntries(entries) {
    const out = [];
    async function walk(entry) {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push(f); res(); }, () => res()));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => new Promise((res) => reader.readEntries((e) => res(e), () => res([])));
        let batch;
        do { batch = await readBatch(); for (const e of batch) await walk(e); } while (batch.length);
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  function onDrop(e) {
    e.preventDefault(); setDragOver(false);
    const dt = e.dataTransfer;
    const entries = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (const it of dt.items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
    }
    if (entries.length) walkEntries(entries).then(onFiles);
    else onFiles(dt.files);
  }

  const toB64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej; r.readAsDataURL(file);
  });

  const matched = rows.filter((r) => r.invoice);
  const unmatched = rows.filter((r) => !r.invoice);

  async function upload() {
    setBusy(true); setDone(0); const e = [];
    for (const m of matched) {
      try {
        const b64 = await toB64(m.file);
        await api.attach({ invoice_id: m.invoice.id, filename: m.file.name, content_base64: b64, content_type: m.file.type || "application/pdf" });
        setDone((d) => d + 1);
      } catch (err) { e.push(`${m.file.name}: ${err.message}`); }
    }
    setErrs(e); setBusy(false); reload();
  }

  if (invoices.length === 0) return (
    <>
      <p className="eyebrow">Attachments</p>
      <h2 className="h">Import your invoices first</h2>
      <p className="sub">Files are matched to invoices by number, so there's nothing to match against until you've imported the tracker.</p>
    </>
  );

  return (
    <>
      <p className="eyebrow">Attachments</p>
      <h2 className="h">Link invoice files</h2>
      <p className="sub">Select all the invoice files (PDFs or images). Each is matched to an invoice by the number at the start of its filename, then attached to that client's reminder. Attachments ride on the automated send, so the "Open in mail" preview won't include them.</p>

      {attachedCount > 0 && <div className="ok">{attachedCount} invoice{attachedCount === 1 ? "" : "s"} already {attachedCount === 1 ? "has" : "have"} a linked file.</div>}

      <div className={"drop" + (dragOver ? " over" : "")} onClick={() => inputRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}>
        <div className="big">Click to choose your invoice folder, or drag the folder here</div>
        <div className="sm">Reads every PDF or image inside, including all subfolders</div>
        <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg" multiple style={{ display: "none" }}
          onChange={(e) => onFiles(e.target.files)} />
      </div>

      {rows.length > 0 && (
        <>
          <div style={{ height: 16 }} />
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="pill green">{matched.length} matched</span>
            {unmatched.length > 0 && <span className="pill" style={{ color: "var(--oxblood)", borderColor: "var(--oxblood)" }}>{unmatched.length} no match</span>}
          </div>
          <div className="prev"><table>
            <thead><tr><th>File</th><th>Matched to</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.file.name}</td>
                  <td style={{ color: r.invoice ? "var(--ink)" : "var(--oxblood)" }}>
                    {r.invoice ? `${r.invoice.client} — ${r.matchNo}` : "no matching invoice"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>

          {errs.length > 0 && <div className="warn" style={{ marginTop: 12 }}>{errs.length} file(s) failed: {errs[0]}</div>}

          <div style={{ height: 14 }} />
          <button className="btn" disabled={busy || matched.length === 0} onClick={upload}>
            {busy ? `Uploading ${done}/${matched.length}…` : `Upload ${matched.length} matched file${matched.length === 1 ? "" : "s"}`}
          </button>
          {unmatched.length > 0 && <p className="miss" style={{ marginTop: 10 }}>Unmatched files usually mean the invoice number in the filename doesn't match any imported invoice, or that invoice wasn't imported.</p>}
        </>
      )}
    </>
  );
}

/* ----------------------------- styles ----------------------------- */
function Style() {
  return <style>{`
    *{box-sizing:border-box}
    .wrap{--paper:#F1ECE0;--paper2:#FBF8F1;--ink:#211E18;--ink2:#5C564A;--rule:#D6CDB8;--oxblood:#A2362B;--green:#3B6B45;--steel:#2A4B6B;
      --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
      background:var(--paper);color:var(--ink);font-family:var(--sans);min-height:100vh;line-height:1.5}
    .wrap *{font-family:inherit}
    .num{font-family:var(--mono);font-variant-numeric:tabular-nums}
    .bar{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:3px double var(--ink);background:var(--paper2)}
    .mark{width:18px;height:18px;background:var(--oxblood);transform:rotate(45deg);flex:0 0 auto}
    .word{font-weight:800;letter-spacing:-.02em;font-size:18px}
    .word small{display:block;font-weight:600;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink2);margin-top:1px}
    .tabs{margin-left:auto;display:flex;gap:6px}
    .tab{font-weight:700;font-size:12px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--rule);background:transparent;color:var(--ink2);padding:7px 12px;border-radius:2px;cursor:pointer}
    .tab.on{background:var(--ink);color:var(--paper2);border-color:var(--ink)}
    .pad{padding:24px 22px 64px;max-width:1080px;margin:0 auto}
    .eyebrow{text-transform:uppercase;letter-spacing:.2em;font-size:11px;font-weight:700;color:var(--ink2);margin:0 0 8px}
    h2.h{font-size:25px;font-weight:800;letter-spacing:-.02em;margin:0 0 6px}
    p.sub{color:var(--ink2);margin:0 0 22px;max-width:62ch}
    .sm2{color:var(--ink2);font-size:12px}
    .drop{border:2px dashed var(--rule);background:var(--paper2);padding:46px 24px;text-align:center;border-radius:3px;cursor:pointer}
    .drop:hover{border-color:var(--oxblood);background:#fff}
    .drop.over{border-color:var(--oxblood);background:#fff}
    .drop .big{font-weight:800;font-size:17px}.drop .sm{color:var(--ink2);font-size:12px;margin-top:6px}
    .btn{font-weight:700;font-size:13px;border:1.5px solid var(--ink);background:var(--ink);color:var(--paper2);padding:10px 16px;border-radius:2px;cursor:pointer}
    .btn:hover{background:#000}.btn:disabled{opacity:.45;cursor:not-allowed}
    .btn.ghost{background:transparent;color:var(--ink)}.btn.ghost:hover{background:#fff}
    .btn.ox{background:var(--oxblood);border-color:var(--oxblood);color:#fff}
    .btn.sm{padding:6px 10px;font-size:12px}
    .card{background:var(--paper2);border:1px solid var(--rule);border-radius:3px}
    table.map{width:100%;border-collapse:collapse}
    table.map td{padding:9px 10px;border-bottom:1px solid var(--rule);vertical-align:middle}
    table.map .lab{font-weight:700;font-size:13px;width:45%}
    select,input[type=text],input[type=date],input[type=password],textarea{font-size:13px;color:var(--ink);border:1px solid var(--rule);background:#fff;border-radius:2px;padding:8px;width:100%}
    select:focus,input:focus,textarea:focus{outline:2px solid var(--steel);outline-offset:-1px}
    .prev{overflow:auto;border:1px solid var(--rule);border-radius:3px}
    .prev table{border-collapse:collapse;width:100%;font-size:12px}
    .prev th{text-align:left;background:#EDE6D6;color:var(--ink2);font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:10px;padding:7px 9px;border-bottom:1px solid var(--rule);white-space:nowrap}
    .prev td{padding:6px 9px;border-bottom:1px solid #EAE3D2;white-space:nowrap}
    .review{display:grid;grid-template-columns:300px 1fr;gap:24px;align-items:start}
    @media(max-width:860px){.review{grid-template-columns:1fr}}
    .rail{position:sticky;top:16px}
    .stat{padding:16px}.stat .big{font-size:30px;font-weight:800;letter-spacing:-.02em}
    .agerow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--rule);font-size:13px}
    .agerow:last-child{border-bottom:none}.agerow .c{margin-left:auto;font-weight:700}
    .dot{width:9px;height:9px;border-radius:2px;flex:0 0 auto}
    .stamp{display:inline-block;border:2px solid var(--oxblood);color:var(--oxblood);font-family:var(--mono);font-weight:700;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 7px;border-radius:2px;transform:rotate(-3deg);margin-left:auto}
    .email{padding:16px;margin-bottom:16px}
    .email .top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .email .who{font-weight:800;font-size:15px}.email .addr{color:var(--ink2);font-size:12px}
    .pills{margin-bottom:8px}
    .pill{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:var(--ink2);border:1px solid var(--rule);padding:2px 7px;border-radius:99px}
    .pill.green{color:var(--green);border-color:var(--green)}
    .bodybox{width:100%;min-height:150px;font-family:var(--mono);font-size:12.5px;line-height:1.55;resize:vertical}
    .acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .cfg{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--ink2);margin:0 0 5px}
    .warn{background:#FBF1EC;border:1px solid #E3B7AD;color:#7B241C;padding:10px 12px;border-radius:3px;font-size:13px}
    .ok{background:#EDF3EE;border:1px solid #B7D2BF;color:#2C5238;padding:10px 12px;border-radius:3px;font-size:13px;margin-bottom:16px}
    .miss{font-size:12.5px;color:var(--ink2)}
    .link{background:none;border:none;color:var(--steel);font-size:12px;cursor:pointer;text-decoration:underline;padding:0 6px 0 0}
  `}</style>;
}
