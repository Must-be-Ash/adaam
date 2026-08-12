const skill = String.raw`---
name: launch-eve
description: Fork, configure, verify, and deploy the Eve personal investment-agent template to a user's GitHub and Vercel accounts. Use when someone asks to launch their own Eve, connect Eve to Photon iMessage, configure Coinbase CDP credentials, or deploy the Eve template.
license: Apache-2.0
metadata:
  source: "https://github.com/Must-be-Ash/earnings-call-analyser"
---

# Launch Eve

Help the user create and deploy their own single-owner Eve from:

https://github.com/Must-be-Ash/earnings-call-analyser

Complete the setup with them. Do not only give them a list of commands.

## Non-negotiable rules

- Treat this as an experimental, single-owner deployment. Do not describe it as broadly live-trading ready.
- Never ask the user to paste an API key, secret, private key, token, or complete credential into chat.
- Never place credentials in source, a command argument, shell history, logs, screenshots, issues, commits, or pull requests.
- Keep secrets only in the user's password manager and encrypted Vercel environment variables. Let the user enter secret values directly in Vercel or a hidden interactive terminal prompt.
- Never perform a trade, transfer, conversion, portfolio mutation, or other financial action during setup or verification.
- Preserve Eve's Coinbase principal allowlist, exact-order preview, expiring approval token, Photon approval card, text fallback, idempotency guard, and uncertain-result protections.
- Do not enable additional Coinbase scopes, non-custodial key export, or policy management.
- Use a dedicated, minimally funded Coinbase Advanced Trade spot portfolio. Do not connect the user's primary holdings.
- Before changing GitHub, Vercel, Photon, Upstash, or Coinbase resources, state what will change and get the user's confirmation.
- Stop on authentication, permission, billing, or manual-confirmation blockers. Ask the user to complete the blocked step instead of trying to bypass it.

## Known boundaries

- The template has no deployment-wide owner allowlist yet. Coinbase has a separate COINBASE_ALLOWED_PRINCIPALS allowlist, but other private capabilities are not owner-global. Tell the user to keep the Photon number private.
- Photon approvals currently support Eve's guarded spot-order creation path. Other Coinbase mutations may be present in the dynamic tool catalog but are rejected by the custom Photon approval path. Do not claim they work end to end.
- The browser Eve API remains fail-closed in production. This quickstart page is public, but the agent API is not a public web chat.
- Photon sessions and approval state require an Upstash Redis resource with both REST credentials and a TLS REDIS_URL.

## 1. Confirm the target

Ask for:

1. The GitHub account or organization that should own the fork.
2. The Vercel account or team that should own the deployment.
3. The desired repository and Vercel project name. Default to eve-agent.
4. Whether the user already has Coinbase Advanced Trade and Photon accounts.

Confirm that the user understands this will create or modify resources in those accounts. Do not ask for any secret values.

## 2. Fork and inspect Eve

Verify GitHub authentication, then fork and clone the public template into a new directory. Do not overwrite an existing directory or repurpose an unrelated repository.

    gh auth status
    gh repo fork Must-be-Ash/earnings-call-analyser --clone

If the user already has a fork, clone or open that fork instead. Set the original template as the upstream remote when useful.

Inside the fork:

1. Use Node.js 24.
2. Read AGENTS.md, HANDOFF.md, README.md, and the relevant installed Eve docs.
3. Run npm install.
4. Run npm run typecheck.
5. Run npm run build before making setup-specific changes.

Do not continue if the untouched fork fails. Explain the failure first.

## 3. Link Vercel and storage

Authenticate with the user's Vercel account and link or create the intended project. Prefer Eve's supported flow:

    npm exec -- eve link

Connect one dedicated Upstash Redis database to that Vercel project. The Vercel Marketplace flow is acceptable. Confirm the project receives:

- KV_REST_API_URL or UPSTASH_REDIS_REST_URL
- KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN
- REDIS_URL using TLS

Do not print any values. Do not reuse the template owner's database.

## 4. Connect Photon iMessage

Use the official Eve registry integration instead of hand-building a Photon connection:

    npm exec -- eve registry view channel/photon-imessage
    npm exec -- eve add channel/photon-imessage --non-interactive

Follow the structured setup output. When it requests an answer, present the real choices to the user and rerun with the requested --answer key=value fields. Do not guess setup answers.

Choose Vercel Connect unless the user explicitly needs portable credentials. The guided flow should:

1. Sign in to Photon when needed.
2. Create or select the user's Photon project.
3. Register or assign the user's iMessage number.
4. Link the user's Vercel project.
5. Create the Photon Vercel Connect connector.
6. Configure the /eve/v1/photon webhook.

This fork contains a custom agent/channels/photon.ts with session routing and financial approval controls. Do not overwrite it with the basic Photon scaffold. After setup, inspect the diff:

- Preserve the custom channel implementation.
- Preserve queue behavior for approval continuations and steer behavior for ordinary messages.
- Preserve the Spectrum session manager and approval mini apps.
- Keep only the setup-specific connector identifier change if the installer made one.

Set PHOTON_CONNECTOR_ID in the Vercel production environment to the exact photon/... connector identifier created for this project. This identifier is not a credential, but it is deployment-specific. Do not copy the template owner's connector.

For portable credentials, follow Eve's Photon documentation and keep IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET, and IMESSAGE_WEBHOOK_SECRET only in encrypted environment variables.

## 5. Create the Coinbase CDP key

Open this page for the user:

https://portal.cdp.coinbase.com/api-keys/secret

The user must complete this step in Coinbase. Do not automate credential capture.

Tell the user to create a new secret API key with a clear nickname and scope it to the dedicated, minimally funded Advanced Trade spot portfolio.

On the key form:

1. Leave the IP allowlist input box completely empty.
2. Enable Opt-out of IP allowlisting. Vercel serverless egress is not fixed, so the IP field cannot be safely pinned here. Compensate with the dedicated minimally funded portfolio and Eve's principal and approval controls.
3. Open Advanced settings.
4. Under Coinbase App & Advanced Trade, select only the intended portfolio.
5. Enable exactly these four permissions:
   - View (read-only)
   - Trade (execute trades on your behalf)
   - Transfer (initiate transfer of funds)
   - Receive (receive inbound payments)
6. Do not change any other permission.
7. Under Account / Non-custodial, leave Export (export private key) disabled.
8. Leave Manage (modify policies) disabled.
9. Keep Ed25519 (Recommended) selected.
10. Do not switch to ECDSA (Legacy SDKs).

Before the user presses Create, repeat the final scope back to them and ask them to confirm it matches the list above.

The Transfer permission is powerful. Explain that the current Photon experience does not support transfer approval end to end and setup will not test or use it.

## 6. Store Coinbase credentials safely

Have the user add these encrypted production environment variables directly in the Vercel dashboard or hidden interactive prompts:

- COINBASE_KEY_ID
- COINBASE_KEY_SECRET

The secret can be a multiline or escaped PEM value. It must be stored exactly as Coinbase provides it. Do not normalize, reformat, echo, inspect, or repeat it.

Leave COINBASE_ALLOWED_PRINCIPALS empty for the first deployment. That is a fail-closed state: the agent can report the caller's principal ID but cannot read the Coinbase portfolio or submit an order.

Do not put live Coinbase credentials in Preview deployments unless the user explicitly accepts that exposure. Production-only is the default.

## 7. Verify and deploy

Run the local checks:

    npm run typecheck
    npm run verify:context
    npm run verify:approvals
    npm run verify:sessions
    npm run verify:workspaces
    npm run build

Fix only setup-related failures. Never weaken a guard or skip a check to make deployment pass.

With the user's confirmation, commit the fork-specific changes, push them to the user's fork, and deploy:

    npm exec -- eve deploy

Do not force-push. Do not include any environment file.

Verify:

    curl https://THE_DEPLOYMENT_HOST/eve/v1/health

Then have the user send Eve an iMessage asking:

    Check my Coinbase access status.

Eve should return the exact private-channel principal ID without credentials or balances. Have the user add that complete value, including the imessage: prefix, to COINBASE_ALLOWED_PRINCIPALS in the Vercel production environment. The user should enter it directly; do not put it in source or logs.

Redeploy after the environment change.

## 8. Final smoke test

From the allowlisted private iMessage conversation:

1. Ask Eve to check Coinbase access status. Confirm allowed is true and credentials are configured.
2. Ask for a read-only Coinbase balance. Confirm no approval is requested for the read.
3. Ask Eve to open the session manager. Create and switch to a test session, then switch back.
4. Do not create a live order as a setup test.
5. Do not test transfers, conversions, portfolio changes, edits, or cancellations.

If a later user explicitly chooses to test a real order, require the normal exact preview and fresh Approve or Deny action. Never treat setup confirmation as financial authorization.

## 9. Hand off

Give the user:

- The GitHub fork URL.
- The production Vercel URL.
- Confirmation that their Photon number is active.
- The health-check result.
- Which optional integrations remain unconfigured, such as FMP, SEC identity, Telegram, or Masterkey.
- A reminder that secrets live only in Vercel and that the Photon number should remain private.

Do not include credential values, Coinbase portfolio identifiers, phone numbers, principal IDs, balances, or financial amounts in the handoff.
`;

export function GET() {
  return new Response(skill, {
    headers: {
      "cache-control": "public, max-age=300, s-maxage=3600",
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
