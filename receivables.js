import { createClient } from "@supabase/supabase-js";

export function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// Simple shared-password gate for the /api/* endpoints the app calls.
export function checkAppPassword(req) {
  const pw = req.headers["x-app-password"];
  return Boolean(process.env.APP_PASSWORD) && pw === process.env.APP_PASSWORD;
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}
