import ChatMessagesDemo from "@/components/ui/chat-messages-2-demo";

import { CopyPrompt } from "./copy-prompt";

export default function Page() {
  return (
    <div className="shell">


      <main className="main">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] lg:gap-8">
          <section className="intro">
            <h1>
              <span>Run trading</span>
              <span className="heading-line-tight">agents from</span>
              <span>iMessage</span>
            </h1>
            <p className="dek">
              Copy trade Pelosi, inverse trade Cramer, or value invest like
              Buffett. Your agents watch each strategy around the clock and ping
              you when they find a signal. All via text.
            </p>
            <CopyPrompt />
          </section>

          <div className="-mx-2 lg:mx-0 lg:justify-self-end">
            <ChatMessagesDemo />
          </div>
        </div>
      </main>

      <footer className="footer">
      <span>Make the market text you.</span>
        <span>Built on Eve by Vercel</span>
      </footer>
    </div>
  );
}
