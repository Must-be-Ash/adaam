import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: process.env.VERCEL ? vercel({ networkPolicy: "deny-all" }) : justbash(),
});
