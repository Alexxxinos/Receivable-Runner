let PW = "";
export const setPassword = (p) => (PW = p);

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-app-password": PW,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("unauthorized");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  list: () => call("GET", "/api/invoices"),
  import: (rows) => call("POST", "/api/invoices", { rows }),
  update: (id, action) => call("PATCH", "/api/invoices", { id, action }),
  draft: (group) => call("POST", "/api/draft", group),
  attach: (payload) => call("POST", "/api/attachments", payload),
};
