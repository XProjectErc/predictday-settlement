# 5-minute demo — how to record it

The program is **live on devnet** and each run creates a fresh market, so the whole flow is a
single command you can run on camera as many takes as you want. Uses historical World Cup data so
it is fully reproducible after the matches end.

## What you need open (before hitting record)
1. A terminal (big font), in this repo folder.
2. Chrome with two tabs:
   - `app/verifiable-resolution.html` (open the file directly)
   - Solana Explorer: https://explorer.solana.com/address/FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq?cluster=devnet

## How to record the screen + your voice
Pick one (Loom is easiest — gives a shareable link instantly):
- **Loom** — install loom.com (app or Chrome extension), click record → Screen + Mic. Stop = you
  get a link. Paste that link in the Superteam form.
- **OBS Studio** — record to MP4, then upload to YouTube as *Unlisted*, use that link.
- **Windows Game Bar** — press Win+G, record; file lands in Videos\Captures; upload to YouTube Unlisted.

## The script (≈5 min) — say this while doing that

**(0:00) Intro ~20s**
> "predict.day is a World Cup prediction market on Solana. The novelty: outcomes are settled
> trustlessly by TxLINE's on-chain cryptographic proofs — no admin decides who won."

**(0:20) It's live on devnet ~30s** — show the Explorer tab.
> "Here's our settlement program deployed on devnet. TxLINE is our primary data source."

**(0:50) Run the full flow ~2m30** — run this and narrate each printed line:
```
RPC=https://api.devnet.solana.com node predictday_settlement/e2e.mjs
```
- "It pulls the live score + the 3-stage Merkle proof from TxLINE, creates a market, places bets."
- "**Watch this**: a keeper submits the WRONG winner — it REVERTS with ProofRejected. The program
  rebuilds the predicate and the on-chain proof says no. A keeper cannot fake the result."
- "Now the real proof: it CPIs into TxLINE's validate_stat, the market settles, and the winner is
  paid. Every step is a real devnet transaction — here are the explorer links."
  (click one of the printed links to show it on-chain)

**(3:20) Anyone can re-verify ~1m** — switch to the receipt tab, click **Verify on-chain**.
> "This receipt re-verifies the score on-chain from the browser, no backend. It simulates
> validate_stat on devnet and returns 0x01 — cryptographically proven."

**(4:20) Close ~20s**
> "TxLINE as the primary source, settlement no operator can fake, and a receipt anyone can check.
> This is live as wcinu.bet today; this repo makes its settlement trustless. Thanks."

## If a take goes wrong
Just run the command again — it makes a brand-new market every time (random nonce), so nothing to reset.

## TxLINE feedback (for the submission form — copy from README)
See the "Feedback on the TxLINE API" section in README.md.
