// Pure helpers shared by the frontend and the serverless cron job.
// No DOM, no Node APIs, so it runs in both places.

export const usd = (n) =>
  isFinite(n) ? Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";

export const fmtDate = (d) =>
  d instanceof Date && !isNaN(d)
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "—";

export function parseAmount(v) {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const c = String(v).replace(/[^0-9.\-]/g, "");
  return c === "" ? NaN : parseFloat(c);
}

function excelSerialToDate(n) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
}

export function parseDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number") return v > 20000 && v < 80000 ? excelSerialToDate(v) : null;
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  return isNaN(t) ? null : new Date(t);
}

export function daysOverdue(due, today) {
  if (!due) return null;
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const b = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((a - b) / 86400000);
}

export function bucketOf(d) {
  if (d == null) return "undated";
  if (d <= 0) return "current";
  if (d <= 30) return "b1";
  if (d <= 60) return "b2";
  if (d <= 90) return "b3";
  return "b4";
}

export const BUCKETS = {
  current: { label: "Not yet due", color: "#2A4B6B" },
  b1: { label: "1–30 days over", color: "#B7791F" },
  b2: { label: "31–60 days over", color: "#C05621" },
  b3: { label: "61–90 days over", color: "#A2362B" },
  b4: { label: "90+ days over", color: "#7B241C" },
  undated: { label: "No due date", color: "#5C564A" },
};

export function tierFor(maxOver) {
  if (maxOver == null || maxOver <= 0) return "upcoming";
  if (maxOver <= 30) return "first";
  if (maxOver <= 60) return "second";
  if (maxOver <= 90) return "third";
  return "final";
}

export const TIER_TAG = {
  upcoming: "Heads-up",
  first: "First reminder",
  second: "Second reminder",
  third: "Firm notice",
  final: "Final notice",
};

// Deterministic template. The cron uses this directly for reliability.
export function buildTemplate({ company, sender, client, rows, total, tier }) {
  const list = rows
    .map(
      (r) =>
        `  - ${r.invoiceNo || "Invoice"} - ${usd(r.amount)} - due ${fmtDate(r.due)}${
          r.over > 0 ? ` (${r.over} days past due)` : ""
        }`
    )
    .join("\n");

  const openers = {
    upcoming: `Hi ${client}, a quick heads-up that the invoice${rows.length > 1 ? "s" : ""} below come due shortly.`,
    first: `Hi ${client}, hope you're well. A friendly reminder on the outstanding invoice${rows.length > 1 ? "s" : ""} below.`,
    second: `Hi ${client}, following up on the invoice${rows.length > 1 ? "s" : ""} below, which remain unpaid. Could you share an expected payment date?`,
    third: `Hi ${client}, the invoice${rows.length > 1 ? "s" : ""} below are now well past due and need your immediate attention.`,
    final: `Hi ${client}, this is a final notice on the significantly overdue balance below. Please treat it as a priority.`,
  };
  const closers = {
    upcoming: `Thanks in advance.`,
    first: `If it's already on the way, please disregard.`,
    second: `If anything is holding payment, just reply and let me know.`,
    third: `Please reply today with a payment date so we can keep the account current.`,
    final: `Please remit payment or contact me directly to arrange it.`,
  };
  const subject =
    tier === "final"
      ? `Final notice - ${usd(total)} past due`
      : tier === "upcoming"
      ? `Upcoming invoice - ${usd(total)}`
      : `Payment reminder - ${usd(total)} outstanding`;

  const body = `${openers[tier]}\n\n${list}\n\nTotal outstanding: ${usd(total)}\n\n${closers[tier]}\n\nBest,\n${sender}\n${company}`;
  return { subject, body };
}

// Turn raw db rows into aged, grouped reminders ready to send.
// `records` are objects: { id, client, email, invoice_no, amount, due_date }
export function buildReminders(records, { today = new Date(), includeDueSoon = false } = {}) {
  const aged = records.map((r) => {
    const due = parseDate(r.due_date);
    const amount = parseAmount(r.amount);
    return {
      id: r.id,
      client: (r.client || "Unknown").trim(),
      email: (r.email || "").trim(),
      invoiceNo: (r.invoice_no || "").trim(),
      amount,
      due,
      over: daysOverdue(due, today),
    };
  });

  const remindable = aged.filter((r) => {
    if (!isFinite(r.amount)) return false;
    if (r.over == null) return false;
    return r.over > 0 || (includeDueSoon && r.over > -7);
  });

  const valid = (e) => /.+@.+\..+/.test(e);
  const sendable = remindable.filter((r) => valid(r.email));
  const missingEmail = remindable.filter((r) => !valid(r.email));

  const groups = {};
  sendable.forEach((r) => {
    const k = r.email.toLowerCase();
    (groups[k] = groups[k] || { client: r.client, email: r.email, rows: [] }).rows.push(r);
  });

  const list = Object.values(groups).map((g) => {
    const total = g.rows.reduce((s, r) => s + r.amount, 0);
    const maxOver = Math.max(...g.rows.map((r) => r.over ?? 0));
    return { ...g, total, maxOver, tier: tierFor(maxOver), ids: g.rows.map((r) => r.id) };
  });
  list.sort((a, b) => b.maxOver - a.maxOver);
  return { groups: list, missingEmail, aged };
}
