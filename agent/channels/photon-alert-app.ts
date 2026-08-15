import { randomBytes } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import {
  PHOTON_ALERT_APP_PATH,
  PHOTON_WORKSPACE_APP_PATH,
} from "../lib/photon-mini-app";
import { applyPhotonAlertDiscussAction } from "../lib/photon-workspace-store";

const requestSchema = z.object({
  alertToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

function headers(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store, max-age=0",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function page(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Discuss workspace alert</title>
<style nonce="${nonce}">body{margin:0;min-height:100svh;display:grid;place-items:center;background:#171717;color:#f2f2f2;font:16px -apple-system,BlinkMacSystemFont,sans-serif}main{width:min(88vw,420px);padding:28px;border:1px solid #333;border-radius:18px;background:#202020}.actions{display:grid;gap:10px}button{width:100%;padding:14px;border:0;border-radius:12px;font:inherit;font-weight:650}.secondary{background:#343434;color:#f2f2f2}p{color:#aaa;line-height:1.45}</style></head>
<body><main><h1>Workspace alert</h1><p id="status">Discuss this alert in its session, or open Manage Eve Sessions.</p><div class="actions"><button id="discuss" type="button">Discuss in workspace</button><button class="secondary" id="manage" type="button">Manage sessions</button></div></main>
<script nonce="${nonce}">const parts=location.hash.slice(1).split(".");const alertToken=parts[0]||"";const managerToken=parts[1]||"";const button=document.getElementById("discuss");const manage=document.getElementById("manage");const status=document.getElementById("status");manage.disabled=!/^[A-Za-z0-9_-]{43}$/.test(managerToken);manage.addEventListener("click",()=>{if(!manage.disabled)location.assign("${PHOTON_WORKSPACE_APP_PATH}#"+managerToken);});button.addEventListener("click",async()=>{button.disabled=true;try{const response=await fetch("${PHOTON_ALERT_APP_PATH}/discuss",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({alertToken})});const body=await response.json();status.textContent=body.message||body.error||"This alert action is unavailable.";if(!response.ok)button.disabled=false;}catch{status.textContent="Eve could not confirm the workspace change. Please reopen the alert.";button.disabled=false;}});</script></body></html>`;
}

async function readRequest(request: Request): Promise<z.infer<typeof requestSchema> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return null;
  try {
    const body = await request.text();
    return body.length <= 1_024 ? requestSchema.parse(JSON.parse(body)) : null;
  } catch {
    return null;
  }
}

export default defineChannel({
  routes: [
    GET(PHOTON_ALERT_APP_PATH, async () => {
      const nonce = randomBytes(18).toString("base64url");
      const responseHeaders = headers("text/html; charset=utf-8");
      responseHeaders["content-security-policy"] =
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`;
      return new Response(page(nonce), { headers: responseHeaders });
    }),
    POST(`${PHOTON_ALERT_APP_PATH}/discuss`, async (request) => {
      const body = await readRequest(request);
      if (!body) {
        return new Response(JSON.stringify({ error: "Invalid alert action." }), {
          headers: headers("application/json; charset=utf-8"),
          status: 400,
        });
      }
      const result = await applyPhotonAlertDiscussAction(body.alertToken);
      const status = result.status === "applied" ? 200 : result.status === "stale" ? 409 : 410;
      const message = result.status === "applied"
        ? `Now using ${result.state.activeWorkspace.name}. Send your next message to discuss the alert.`
        : result.status === "stale"
          ? "This alert action is stale because the session selection changed. Open Manage sessions to review it."
          : "This alert action expired or its workspace is unavailable. Open Manage sessions to review it.";
      return new Response(JSON.stringify({ message, status: result.status }), {
        headers: headers("application/json; charset=utf-8"),
        status,
      });
    }),
  ],
});
