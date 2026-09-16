import ChatMessagesDemo from "@/components/ui/chat-messages-2-demo";

import { CopyPrompt } from "./copy-prompt";

export default function Page() {
  return (
    <div className="shell">
      <header className="masthead">
        <a
          className="github-link"
          href="https://github.com/Must-be-Ash/adaam"
          target="_blank"
          rel="noreferrer"
        >
          <svg className="github-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7.25A5.65 5.65 0 0 0 19.22 3.3 5.4 5.4 0 0 0 19.08 1S17.9.65 15 2.48a13.38 13.38 0 0 0-7 0C5.1.65 3.92 1 3.92 1a5.4 5.4 0 0 0-.14 2.3A5.65 5.65 0 0 0 2.28 7.25c0 5.63 3.44 6.88 6.72 7.25A4.8 4.8 0 0 0 8 18v4" />
            <path d="M8 19c-3 .9-3-1.5-4-2" />
          </svg>
          <span>GitHub</span>
        </a>
      </header>

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
