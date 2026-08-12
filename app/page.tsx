import { CopyPrompt } from "./copy-prompt";

export default function Page() {
  return (
    <div className="shell">
      <header className="masthead">
        <span className="wordmark">Eve</span>
        <span className="edition">Open agent template</span>
      </header>

      <main className="main">
        <section className="intro">
          <p className="eyebrow">Your agent. Your accounts. Your rules.</p>
          <h1>Run your own Eve.</h1>
          <p className="dek">
            Fork the agent, connect iMessage and Coinbase, and deploy it to your
            Vercel.
          </p>
        </section>

        <CopyPrompt />
      </main>

      <footer className="footer">
        <span>Built with Eve</span>
        <span>iMessage · Coinbase · Vercel</span>
      </footer>
    </div>
  );
}
