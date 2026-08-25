const skill = String.raw`---
name: launch-eve
description: Fork, configure, verify, and deploy the Eve personal investment-agent template to a user's GitHub and Vercel accounts. Use when someone asks to launch their own Eve, connect Eve to Photon iMessage, configure Coinbase CDP credentials, or deploy the Eve template.
metadata:
  source: "https://github.com/Must-be-Ash/adaam"
---

# Launch Eve

Help the user create and deploy their own single-owner Eve from:

https://github.com/Must-be-Ash/adaam

Complete the setup with them. Do not stop after giving them instructions or a
list of commands. Unless a user-owned action blocks you, finish with a fork in
their GitHub account, an installed and verified local checkout, configured
Photon and Coinbase connections, a pushed setup commit, a production Vercel
deployment, and a passing health check.

## How to run the setup

- Lead the setup one stage at a time and keep a short progress checklist.
- Ask one concise question at a time only when the answer changes the next action.
- Run commands, inspect output, edit fork-specific configuration, and verify each stage yourself when your tools permit it.
- For login, account consent, billing, phone-number registration, or secret entry, explain the exact provider screen and field the user must use, then wait for them to reply that it is complete.
- Ask whether the user already has a Coinbase CDP key or Photon iMessage number ready. Never ask them to paste the key, secret, or phone number into chat.
- Resume automatically from the blocked stage after the user completes a manual action. Do not restart the runbook.
- Before every external write, summarize the resource that will change and obtain confirmation.
- If a check fails, diagnose it and fix only setup-related problems. Never skip or weaken a guard to continue.

## Non-negotiable rules

- Treat this as an experimental, single-owner deployment. Do not describe it as broadly live-trading ready.
- Never ask the user to paste an API key, secret, private key, token, complete credential, or phone number into chat.
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

Ask for these details one at a time:

1. The GitHub account or organization that should own the fork.
2. The Vercel account or team that should own the deployment.
3. The desired repository and Vercel project name. Default to eve-agent.
4. Whether the user already has Coinbase Advanced Trade and Photon accounts.
5. Whether they already created a dedicated Coinbase CDP key for this agent.
6. Whether they have an iMessage-capable phone number ready to register or select in Photon.

Ask only for readiness and account choices, not credential values or the phone
number itself. Confirm that the user understands this will create or modify
resources in those accounts and that the deployment currently has no general
owner allowlist outside the separate Coinbase principal allowlist.

## 2. Fork and inspect Eve

Tell the user which GitHub owner and repository name you will create, get their
confirmation, then verify GitHub authentication and source access. Fork and
clone the template into a new directory yourself. Do not overwrite an existing
directory or repurpose an unrelated repository.

    gh auth status
    gh repo view Must-be-Ash/adaam --json nameWithOwner,visibility
    gh repo fork Must-be-Ash/adaam --clone

If the source is private and the user cannot access it, stop and explain that
the owner must grant access or publish the template. If the user already has a
fork, clone or open that fork instead. Set the original template as the upstream
remote when useful.

Inside the fork:

1. Use Node.js 24.
2. Read AGENTS.md and the relevant installed Eve docs.
3. Run npm install yourself and inspect any failure.
4. Run npm run typecheck.
5. Run npm run build before making setup-specific changes.
6. Confirm git status contains no unexpected files or credentials.

Do not continue if the untouched fork fails. Explain the failure first.

## 3. Link Vercel and storage

Tell the user which Vercel team and project you will create or link, get their
confirmation, then authenticate with their Vercel account and perform the link.
Prefer Eve's supported flow:

    npm exec -- eve link

If Vercel requires browser login or account consent, give the user the login
step and wait for completion, then continue the command. Connect one dedicated
Upstash Redis database to that Vercel project. The Vercel Marketplace flow is
acceptable; guide the user through it screen by screen if it requires manual
account or billing confirmation.

Verify that the project receives these variable names without printing their
values:

- KV_REST_API_URL or UPSTASH_REDIS_REST_URL
- KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN
- REDIS_URL using TLS

Do not print or inspect secret values. Do not reuse the template owner's
database. Do not proceed until storage is attached.

## 4. Connect Photon iMessage

Ask whether the user already has a Photon account and an iMessage-capable number
ready. If not, guide them through creating the account and preparing a number in
Photon. When Photon requests the number, have the user type or select it directly
in Photon; never request it in chat.

Use the official Eve registry integration instead of hand-building a Photon
connection. Run these commands yourself:

    npm exec -- eve registry view channel/photon-imessage
    npm exec -- eve add channel/photon-imessage --non-interactive

Follow the structured setup output. When it requests an answer, present only the
real choices to the user and rerun with the requested --answer key=value fields.
Do not guess setup answers.

Choose Vercel Connect unless the user explicitly needs portable credentials. The guided flow should:

1. Sign in to Photon when needed.
2. Create or select the user's Photon project.
3. Pause while the user registers or assigns their iMessage number directly in Photon, then continue after they confirm completion.
4. Link the user's Vercel project.
5. Create the Photon Vercel Connect connector.
6. Configure the /eve/v1/photon webhook.

This fork contains a custom agent/channels/photon.ts with session routing and financial approval controls. Do not overwrite it with the basic Photon scaffold. After setup, inspect the diff:

- Preserve the custom channel implementation.
- Preserve queue behavior for approval continuations and steer behavior for ordinary messages.
- Preserve the Spectrum session manager and approval mini apps.
- Keep only the setup-specific connector identifier change if the installer made one.

Set PHOTON_CONNECTOR_ID in the Vercel production environment to the exact
photon/... connector identifier created for this project. This identifier is not
a credential, but it is deployment-specific. Do not copy the template owner's
connector. Verify that the variable name exists in Production without printing
its value.

For portable credentials, follow Eve's Photon documentation and have the user
enter IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET, and
IMESSAGE_WEBHOOK_SECRET directly into encrypted environment variables. Never
relay those values through chat.

## 5. Create the Coinbase CDP key

Ask whether the user already has a dedicated Coinbase CDP key for this agent.
If they do, guide them through checking its portfolio and permissions without
showing or sharing the key. If they do not, open this page for them:

https://portal.cdp.coinbase.com/api-keys/secret

The user must complete credential creation in Coinbase. Guide the form one
section at a time, but do not automate credential capture and do not ask them to
paste either credential into chat.

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

Before the user presses Create, repeat the final scope back to them and ask them
to confirm it matches the list above. Then ask them to create the key, store it
in their password manager, and reply only that creation is complete.

The Transfer permission is powerful. Explain that the current Photon experience does not support transfer approval end to end and setup will not test or use it.

## 6. Store Coinbase credentials safely

Ask the user to open the linked Vercel project's Production environment-variable
screen. Have them add these names and paste each value directly into Vercel:

- COINBASE_KEY_ID
- COINBASE_KEY_SECRET

If the environment supports a genuinely hidden interactive prompt, you may
initiate it and let the user type the value directly. Never place a value in a
command argument. The secret can be a multiline or escaped PEM value and must be
stored exactly as Coinbase provides it. Do not normalize, reformat, echo,
inspect, or repeat it.

After the user confirms both are saved, verify only that the two variable names
exist in Production. Do not retrieve their values.

Leave COINBASE_ALLOWED_PRINCIPALS empty for the first deployment. That is a fail-closed state: the agent can report the caller's principal ID but cannot read the Coinbase portfolio or submit an order.

Do not put live Coinbase credentials in Preview deployments unless the user explicitly accepts that exposure. Production-only is the default.

## 7. Verify and deploy

Run these local checks yourself:

    npm run typecheck
    npm run verify:context
    npm run verify:approvals
    npm run verify:sessions
    npm run verify:workspaces
    npm run build

Fix only setup-related failures. Never weaken a guard or skip a check to make deployment pass.

Inspect git status and the complete diff. Confirm that no environment file,
credential, phone number, principal ID, or generated local state is staged.
Summarize the fork-specific changes and ask the user for confirmation to commit,
push, and deploy. After confirmation, perform all three actions yourself:

    npm exec -- eve deploy

Use a normal git commit and push to the user's fork before deployment. Do not
force-push. Do not include any environment file.

Verify the production deployment yourself:

    curl https://THE_DEPLOYMENT_HOST/eve/v1/health

Then have the user send Eve an iMessage asking:

    Check my Coinbase access status.

Eve should return the exact private-channel principal ID without credentials or balances. Have the user add that complete value, including the imessage: prefix, to COINBASE_ALLOWED_PRINCIPALS in the Vercel production environment. The user should enter it directly; do not put it in source or logs.

After the user confirms the allowlist value is saved, redeploy the latest pushed
commit and repeat the health check.

## 8. Final smoke test

From the allowlisted private iMessage conversation:

1. Ask Eve to check Coinbase access status. Confirm allowed is true and credentials are configured.
2. Ask for a read-only Coinbase balance. Confirm no approval is requested for the read.
3. Ask Eve to open the session manager. Create and switch to a test session, then switch back.
4. Do not create a live order as a setup test.
5. Do not test transfers, conversions, portfolio changes, edits, or cancellations.

If a later user explicitly chooses to test a real order, require the normal exact preview and fresh Approve or Deny action. Never treat setup confirmation as financial authorization.

## 9. Hand off

Do not declare setup complete until:

- The repository exists in the user's GitHub account and the setup commit is pushed.
- Installation, typecheck, regression checks, and production build pass.
- The user's Vercel project has its own storage, Photon connector, and required encrypted environment variables.
- The production health endpoint reports ready.
- Photon can receive and answer an iMessage from the user.
- Coinbase access is fail-closed until the private-channel principal is allowlisted, then a read-only access check succeeds.

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
