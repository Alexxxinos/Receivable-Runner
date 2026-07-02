import { db, checkAppPassword, readJson } from "./_lib.js";

// Uploads one invoice file to Supabase Storage (bucket "invoices") and records
// its path on the matching invoice row. The frontend matches filename -> invoice
// and posts one file at a time so each request stays small.
export default async function handler(req, res) {
  if (!checkAppPassword(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { invoice_id, filename, content_base64, content_type } = await readJson(req);
    if (!invoice_id || !filename || !content_base64) {
      res.status(400).json({ error: "invoice_id, filename and content_base64 are required" });
      return;
    }
    const supabase = db();
    const safe = String(filename).replace(/[^\w.\- ]/g, "_");
    const path = `${invoice_id}/${safe}`;
    const buffer = Buffer.from(content_base64, "base64");

    const { error: upErr } = await supabase.storage
      .from("invoices")
      .upload(path, buffer, {
        contentType: content_type || "application/octet-stream",
        upsert: true,
      });
    if (upErr) throw upErr;

    const { error } = await supabase
      .from("invoices")
      .update({ attachment_path: path, attachment_name: filename, updated_at: new Date().toISOString() })
      .eq("id", invoice_id);
    if (error) throw error;

    res.status(200).json({ ok: true, path });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
