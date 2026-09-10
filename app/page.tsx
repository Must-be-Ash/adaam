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
              Choose a strategy like tracking congressional trades, following
              specific X accounts, watching new IPO filings, or build your
              own. You set the conditions, your agent runs around the clock
              and texts you the moment it spots a signal.
            </p>
            <CopyPrompt />
          </section>

          <div className="-mx-2 lg:mx-0 lg:justify-self-end">
            <ChatMessagesDemo />
          </div>
        </div>
      </main>

      <footer className="footer">
        <span>
          For informational purposes only; not investment advice or a
          recommendation. Trading involves substantial risk, including the
          potential loss of your entire investment. AI agents may make
          mistakes or fail. You direct all agent activity and assume all risk
          for transactions your agents execute, as well as for any use of
          your data by third-party AI providers. All third party trademarks
          belong to their respective owners.
        </span>
      </footer>
    </div>
  );
}
