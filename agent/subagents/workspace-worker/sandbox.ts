import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { vercel } from "eve/sandbox/vercel";

// The worker exposes no shell or filesystem tools. Its sandbox is needed only
// to materialize dynamically scoped monitoring capabilities. Hosted Workflow
// steps cannot persist just-bash's local cache under the read-only function
// filesystem, so production uses Vercel Sandbox while local verification keeps
// the dependency-free backend.
export default defineSandbox({
  backend: process.env.VERCEL ? vercel({ networkPolicy: "deny-all" }) : justbash(),
});
