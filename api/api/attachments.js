import { db, checkAppPassword, readJson } from "./_lib.js";

// Two small actions. "sign" hands the browser a short-lived URL to upload the
// file straight to Supabase Storage (so file bytes never pass through this
// function, avoiding the request size limit). "confirm" records the link.
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
    const body = await readJson(req);
    const supabase = db();

    if (body.action === "sign") {
      const { invoice_id, filename } = body;
      if (!invoice_id || !filename) {
        res.status(400).json({ error: "invoice_id and filename required" });
        return;
      }
      const safe = String(filename).replace(/[^\w.\- ]/g, "_");
      const path = `${invoice_id}/${safe}`;
      const { data, error } = await supabase.storage
        .from("invoices")
        .createSignedUploadUrl(path, { upsert: true });
      if (error) throw error;
      res.status(200).json({ signedUrl: data.signedUrl, path });
      return;
    }

    if (body.action === "confirm") {
      const { invoice_id, path, filename } = body;
      if (!invoice_id || !path) {
        res.status(400).json({ error: "invoice_id and path required" });
        return;
      }
      const { error } = await supabase
        .from("invoices")
        .update({ attachment_path: path, attachment_name: filename, updated_at: new Date().toISOString() })
        .eq("id", invoice_id);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
