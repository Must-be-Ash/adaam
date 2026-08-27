# Contributing

Thanks for your interest in Eve. This is an **experimental** project, and to keep
the core runtime stable and safe, contributions are accepted in **one form only**:

## Strategy packs only

The only contributions accepted are **new, isolated strategy packs** added under
`strategy-packs/`. Each pack is self-contained and declarative — it must not
modify the agent runtime, brokerage plumbing, adapters, or any shared library.

**What a strategy-pack contribution may include**

- A new directory under `strategy-packs/<your-pack>/`
- Declarative capability, source, finding, presentation, and evaluation
  definitions scoped entirely to that directory

**What will not be accepted**

- Changes to `agent/`, `app/`, `lib/`, `packages/`, or `scripts/`
- Changes to Coinbase/brokerage logic, approval guards, or the owner allowlist
- New third-party dependencies
- Anything that reads or writes state outside your own pack

## Ground rules

- **Never include secrets or credentials.** No API keys, tokens, or private
  keys — in code, fixtures, or examples.
- **No live trading logic.** Packs are research/signal verticals; every trade
  still routes through the existing explicit-approval guard.
- Keep each PR to a single strategy pack so it can be reviewed in isolation.

## How to submit

1. Fork the repo and create a branch.
2. Add your pack under `strategy-packs/<your-pack>/`.
3. Open a PR describing what the pack does and where its signals come from.

Because the project is experimental, packs may be rejected or asked to change
without a stability guarantee. See [`strategy-packs/README.md`](strategy-packs/README.md)
for how packs are structured and validated.
