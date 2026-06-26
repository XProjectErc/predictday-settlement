# Response to code review (`predictday-settlement`)

Thanks — sharp review. Actioned below. Program redeployed + hardened on devnet
(`FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq`), e2e (init → bet → fraud-revert → settle → claim) still passes.

| # | Sev | Status | What changed |
|---|-----|--------|--------------|
| 1 | HIGH | ✅ Fixed | `place_bet` now requires `Clock::now < closes_at` (`BettingClosed`); `initialize_market` rejects `closes_at == 0` / `settle_after < closes_at` (`BadSchedule`). e2e sets a real betting window. |
| 2 | HIGH | ⚠️ Mitigated + flagged | Added a `settle_after` gate (`TooEarlyToSettle`) so settlement can't happen mid-match. **Full finality (reject a non-final seq) is NOT achievable on-chain with the current data layer** — TxLINE's *provable* stats are score counts; `GameState`/`StatusId` live in the feed, not the Merkle set. So a malicious keeper could still prove an earlier seq's total. Documented as a limitation + raised as TxLINE API feedback (a provable "match-finished" stat would close it). |
| 3 | MED | ✅ Fixed | Goal stat keys are now hardcoded constants (`HOME_GOALS_KEY=1002`, `AWAY_GOALS_KEY=1003`) instead of attacker-supplied init args — a griefer can no longer create an unsettleable market. |
| 4 | MED | ✅ Fixed | Added `void_market` (authority), `claim_refund` (full stake back on void), and `sweep_fees` (one-time rake withdrawal). `settle_with_proof` auto-voids when `winning_pool == 0` so the pool is refundable instead of stuck. Market now stores an `authority`. |
| 5 | MED | ✅ Fixed | `settle_with_proof` derives the expected `daily_scores_roots` PDA on-chain from the proven `ts` and `require_keys_eq!`s the passed account (`WrongDayRoot`) — no longer trusting txoracle alone. |
| 6 | LOW | ✅ Fixed | The native spike now pins the txoracle program id (`IncorrectProgramId`) + a loud "do not copy to prod" comment. |
| 7 | LOW | ✅ Addressed | Pro-rata dust is recoverable via `sweep_fees` (it stays with the rake slack in the vault). |
| 8 | LOW | ✅ Fixed | `keeper.mjs`, `e2e.mjs`, `gen_receipt.mjs` now resolve paths from `import.meta.url` — the README run steps work anywhere. |
| 9 | INFO | ✅ Noted | Stale `TXLINE_MINT` IDL constant already worked around; raised upstream in the API feedback. |

## On #2 (the one we couldn't fully close)
This is the honest residual: trustless settlement here is only as final as the seq the keeper proves, and the data layer exposes no *provable* finished-marker. Options if we want it fully trustless:
- TxLINE adds a provable match-status / "is_final" stat → we `require!` it.
- Or a dispute window (propose-settlement + challenge) like wcinu-arena, where a wrong-seq settlement can be contested before funds release.

For the hackathon build the keeper is our own backend (trusted), and `settle_after` + the proof-binding make a *casual* exploit impractical; we flagged the rest rather than hide it.
