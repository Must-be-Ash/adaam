import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export const eve = eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
  uploadPolicy: {
    allowedMediaTypes: [
      "application/pdf",
      "image/*",
      "text/markdown",
      "text/plain",
    ],
    maxBytes: 20 * 1024 * 1024,
  },
});

export default eve;
