import { db, checkAppPassword, readJson } from "./_lib.js";

export default async function handler(req, res) {
  if (!checkAppPassword(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const supabase = db();

  try {
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .order("due_date", { ascending: true });
      if (error) throw error;
      res.status(200).json({ invoices: data });
      return;
    }

    if (req.method === "POST") {
      // bulk import. rows: [{client,email,invoice_no,amount,due_date,status}]
      const { rows } = await readJson(req);
      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: "No rows provided" });
        return;
      }
      const clean = rows
        .map((r) => ({
          client: String(r.client || "").trim() || "Unknown",
          email: String(r.email || "").trim() || null,
          invoice_no: String(r.invoice_no || "").trim() || null,
          amount: Number(r.amount),
          due_date: r.due_date || null,
          status: String(r.status || "unpaid").trim().toLowerCase(),
        }))
        .filter((r) => isFinite(r.amount));

      const withNoRaw = clean.filter((r) => r.invoice_no);
      const withoutNo = clean.filter((r) => !r.invoice_no);

      // collapse duplicate invoice numbers within this upload (keep the last),
      // otherwise the upsert tries to touch the same row twice and errors.
      const byNo = new Map();
      for (const r of withNoRaw) byNo.set(r.invoice_no, r);
      const withNo = [...byNo.values()];

      let upserted = 0;
      if (withNo.length) {
        const { error, count } = await supabase
          .from("invoices")
          .upsert(withNo, { onConflict: "invoice_no", count: "exact" });
        if (error) throw error;
        upserted += count ?? withNo.length;
      }
      if (withoutNo.length) {
        const { error } = await supabase.from("invoices").insert(withoutNo);
        if (error) throw error;
        upserted += withoutNo.length;
      }
      res.status(200).json({ imported: upserted });
      return;
    }

    if (req.method === "PATCH") {
      const { id, action } = await readJson(req);
      if (!id || !action) {
        res.status(400).json({ error: "id and action required" });
        return;
      }
      const patch = {
        paid: { status: "paid" },
        unpaid: { status: "unpaid" },
        pause: { paused: true },
        unpause: { paused: false },
      }[action];
      if (!patch) {
        res.status(400).json({ error: "Unknown action" });
        return;
      }
      patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("invoices").update(patch).eq("id", id);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
