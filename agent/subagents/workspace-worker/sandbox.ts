import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// The worker exposes no shell or filesystem tools. Its sandbox is needed only
// to materialize the dynamically scoped monitoring skill, so keep that local
// and dependency-free instead of selecting an optional VM backend.
export default defineSandbox({
  backend: justbash(),
});
