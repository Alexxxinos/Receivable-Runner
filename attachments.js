import { checkAppPassword, readJson } from "./_lib.js";
import { usd, fmtDate, TIER_TAG } from "../lib/receivables.js";

export default async function handler(req, res) {
  if (!checkAppPassword(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const tones = {
    upcoming: "warm and brief, a courtesy heads-up before the due date",
    first: "friendly and light, assume it simply slipped through",
    second: "polite but a touch firmer, ask for a status or expected pay date",
    third: "firm and direct, request immediate attention and a concrete date",
    final: "serious and formal, flag the account is significantly past due, stay professional",
  };

  try {
    const { company, sender, client, rows, total, tier } = await readJson(req);
    const invoiceList = (rows || [])
      .map(
        (r) =>
          `${r.invoiceNo || "Invoice"}: ${usd(r.amount)}, due ${fmtDate(new Date(r.due))}${
            r.over > 0 ? `, ${r.over} days past due` : ""
          }`
      )
      .join("; ");

    const prompt = `Write a short accounts-receivable payment reminder email.

From: ${sender} at ${company}
To client: ${client}
Outstanding invoices: ${invoiceList}
Total outstanding: ${usd(total)}
Desired tone: ${tones[tier] || tones.first} (${TIER_TAG[tier] || ""})

Rules:
- Under 120 words. Professional, plain, no fluff.
- List the invoices clearly. One clear ask.
- Use the real names given, no placeholders. Do not use em dashes.
- Respond with ONLY a JSON object, no markdown: {"subject":"...","body":"..."}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
    if (!parsed.subject || !parsed.body) throw new Error("bad shape");
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
