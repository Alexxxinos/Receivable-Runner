import { db } from "./_lib.js";
import { buildReminders, buildTemplate } from "../lib/receivables.js";

// Triggered by Vercel Cron (see vercel.json). Secured with CRON_SECRET.
export default async function handler(req, res) {
  const auth = req.headers["authorization"] || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = db();
  const company = process.env.SENDER_COMPANY || "Your Company";
  const sender = process.env.SENDER_NAME || "Accounts Receivable";
  const from = process.env.FROM_EMAIL; // e.g. "Billing <billing@yourdomain.com>"
  const replyTo = process.env.REPLY_TO || undefined;
  const includeDueSoon = process.env.INCLUDE_DUE_SOON === "true";

  try {
    // pull candidates: unpaid, not paused, and not reminded in the last 7 days
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: rows, error } = await supabase
      .from("invoices")
      .select("*")
      .eq("status", "unpaid")
      .eq("paused", false)
      .or(`last_reminded_at.is.null,last_reminded_at.lt.${weekAgo}`);
    if (error) throw error;

    const { groups } = buildReminders(rows || [], { today: new Date(), includeDueSoon });
    if (groups.length === 0) {
      res.status(200).json({ ok: true, sent: 0, message: "Nothing due this week." });
      return;
    }

    const results = [];
    for (const g of groups) {
      const { subject, body } = buildTemplate({
        company,
        sender,
        client: g.client,
        rows: g.rows,
        total: g.total,
        tier: g.tier,
      });

      const send = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [g.email],
          subject,
          text: body,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });

      if (send.ok) {
        // single db function stamps the time and bumps the counter for all ids
        await supabase.rpc("mark_reminded", { ids: g.ids });
        results.push({ to: g.email, status: "sent", invoices: g.ids.length });
      } else {
        const err = await send.json().catch(() => ({}));
        results.push({ to: g.email, status: "failed", error: err });
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    res.status(200).json({ ok: true, sent, total: groups.length, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
