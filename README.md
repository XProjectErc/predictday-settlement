# predict.day — Trustless World Cup settlement on Solana, powered by TxLINE

A prediction market whose outcomes are settled **trustlessly** by TxLINE's on-chain
cryptographic score proofs. No admin key decides who won: an on-chain program rebuilds the
outcome predicate itself and verifies a 3-stage Merkle proof against TxLINE's published daily
roots via a CPI into `txoracle.validate_stat`. If the proof checks out, escrow releases to
winners; if a keeper submits the wrong winner, the transaction reverts.

> Built for the TxODDS x Superteam hackathon, Track 1 (Prediction Markets & Settlement).
> Submitted by the team behind [wcinu.bet](https://wcinu.bet) (live World Cup prediction market on Solana).

## Why this matters

Most prediction markets settle off-chain: an operator reads a score feed and flips a switch.
That operator key is the single point of trust (and failure). Here, settlement is a pure
function of a cryptographic proof anchored on-chain by TxLINE. The settling party is **untrusted**.

## How it works

```
TxLINE (txoracle)                 predict.day
─────────────────                 ───────────
SSE scores stream  ┐
REST snapshots     ├─ adapter ──► keeper ──► settle_with_proof(winning_option, proof…)
3-stage Merkle     ┘  (src/      (src/        │
  stat-validation     txline.js)  keeper.mjs) │  builds predicate ON-CHAIN from winning_option
daily_scores roots ◄──────────────────────────┤  (home: h-a>0, draw: ==0, away: <0)
  (on-chain PDA)        CPI validate_stat ─────┤  binds proof to fixture_id + home/away stat keys
                        returns bool ──────────┘  → release escrow on TRUE, revert on FALSE
                                                 claim() pays winners pro-rata
Verifiable Resolution Receipt (app/verifiable-resolution.html)
  → anyone re-verifies the score on-chain client-side (simulateTransaction), zero backend.
```

## Proven on devnet

- **TxLINE program (`txoracle`)**: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet).
- **`validate_stat` is a returning view**: it sets return-data `0x01`/`0x00` (verified by
  simulation + a real CPI). ~191k CU, fits a single tx ~7x over.
- **CPI proof (native)** `settle_spike` `22DsfHPcPi1VMWSwahNSbokzQmZF82BWxCFgcRuYXe3J`:
  real devnet txs releasing on TRUE / reverting on FALSE.
- **Settlement program (Anchor)** `predictday_settlement`
  [`FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq`](https://explorer.solana.com/address/FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq?cluster=devnet)
  — **LIVE ON DEVNET**: full escrow + `settle_with_proof` + `claim`, including a fraud test
  (wrong winner ⇒ `ProofRejected`).

### Live devnet transactions (fixture 17952170, 1-0 home win)
| Step | Tx |
|---|---|
| `settle_with_proof` (CPI into validate_stat) | [`1tZFmW9L…`](https://explorer.solana.com/tx/1tZFmW9Lc3nzRq7ygDfwiwmY6JgCCAMmvPpdYB8YZv7nwdJifyaL5hSPqsmxZy8GhxtxC3hcXkuqNr8kC1JApCw?cluster=devnet) |
| fraud attempt (wrong winner) | reverts on-chain with `ProofRejected` |
| `claim` (winner paid pro-rata) | [`49AfKbUg…`](https://explorer.solana.com/tx/49AfKbUgYWfkYQQe1AafYV4y3k79JEhYNGTSUkEXVAWY79A3GDMvLD6SqNkaq5DXr9WFUTu7ezxzX6gPwehTEQuZ?cluster=devnet) |

Reproduce: `RPC=https://api.devnet.solana.com node predictday_settlement/e2e.mjs`

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT
- `POST /api/token/activate` — activate apiToken after on-chain `subscribe` (free WC tier)
- `GET  /api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]` — the 3-stage Merkle bundle
- `GET  /api/scores/snapshot/{fixtureId}` , `/api/scores/updates/{epochDay}/{hour}/{interval}`
- `GET  /api/scores/stream` — live SSE scores
- on-chain `txoracle.validate_stat` (CPI), `daily_scores_roots` PDA

## Layout

```
src/txline.js          TxLINE adapter (auth, scores, proofs, SSE) — the primary data source
src/keeper.mjs          settlement keeper (proof → settle_with_proof) + CLI
src/gen_receipt.mjs     generates the verifiable resolution receipt page
app/verifiable-resolution.html   self-contained, client-side on-chain re-verification
predictday_settlement/  Anchor program (escrow + settle_with_proof + claim) + e2e.mjs
  programs/predictday_settlement/src/lib.rs          program
  programs/predictday_settlement/src/txoracle_cpi.rs typed validate_stat CPI
01_auth_subscribe.mjs 02_validate_stat.mjs 03_cpi_settle.mjs   devnet spikes (reference)
```

## Run it

Prereqs: Solana CLI, Anchor 0.30.1, Node 20+. `npm install` at repo root.

```bash
# 1. authenticate to the free World Cup tier (on-chain subscribe + activate) — needs devnet SOL
node 01_auth_subscribe.mjs                 # writes auth.json (gitignored)

# 2. build the settlement program
cd predictday_settlement && anchor build && cd ..

# 3. local validator cloning the REAL txoracle program + a daily_scores account from devnet
solana-test-validator --reset \
  --url https://api.devnet.solana.com \
  --clone-upgradeable-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J \
  --clone HYo6qqMUXRaMit2YF6q6YEh5K1mWYBFC3pDZrV2HZN5f
# deploy + end-to-end (init → bet → fraud-revert → keeper settle → claim)
solana program deploy predictday_settlement/target/deploy/predictday_settlement.so \
  --program-id predictday_settlement/program-keypair.json --url http://127.0.0.1:8899
node predictday_settlement/e2e.mjs

# 4. generate + open the verifiable receipt
node src/gen_receipt.mjs && open app/verifiable-resolution.html
```

Set `RPC_URL` to use your own RPC (public devnet faucets are heavily rate-limited).

## Feedback on the TxLINE API

What worked well:
- `validate_stat` returning a bool via **return-data** makes on-chain CPI settlement clean — we
  read the verdict with `get_return_data()` and branch in our own program. This is the right
  primitive for trustless settlement.
- The free World Cup tier (on-chain `subscribe` + signature activation) was quick to stand up,
  and historical `stat-validation` lets us build reproducible demos after matches end.
- Publishing daily Merkle roots on-chain (`daily_scores_roots`) is what makes the whole thing
  trustless — excellent design choice.

Friction we hit (and worked around):
- The IDL constant `TXLINE_MINT` (`AfDqUk86…`) does not match the mint the deployed devnet
  program expects (`4Zao8ocP…`); `subscribe` fails with `InvalidMint` until you use the real one.
  We found it by decoding a successful on-chain `subscribe`. Worth fixing the IDL constant.
- `validate_stat` has no `returns` field in the published on-chain IDL, so Anchor's `.view()`
  needs return-data handling rather than auto-decode. The docs only show `.view()`, not a CPI
  example — a short "CPI into validate_stat + get_return_data" snippet would help a lot (it's the
  headline use case for this track).
- Devnet `request_devnet_faucet` gives USDT but you still need SOL for fees; a note on funding
  would smooth onboarding.
```
