# Response to code review (`predictday-settlement`)

Thanks — sharp review. Actioned below. Program redeployed + hardened on devnet
(`FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq`), e2e (init → bet → fraud-revert → settle → claim) still passes.

| # | Sev | Status | What changed |
|---|-----|--------|--------------|
| 1 | HIGH | ✅ Fixed | `place_bet` now requires `Clock::now < closes_at` (`BettingClosed`); `initialize_market` rejects `closes_at == 0` / `settle_after < closes_at` (`BadSchedule`). e2e sets a real betting window. |
| 2 | HIGH | ✅ Fixed | Two guards: a `settle_after` wall-clock gate (`TooEarlyToSettle`), **and a finality binding** — `settle_with_proof` now requires the **Merkle-proven** `update_stats.max_timestamp >= min_final_ts` (`ScoreNotFinal`). Since a score is final once the match ends and `max_timestamp` is part of the proof, the keeper is forced to prove post-full-time data = the FINAL score; an earlier/transient seq is rejected. e2e step 6 demonstrates the revert. Residual assumption: the match is actually over by `min_final_ts` (set from the real kickoff + match duration); abnormal over-runs/postponements fall to the authority `void` path. |
| 3 | MED | ✅ Fixed | Goal stat keys are now hardcoded constants (`HOME_GOALS_KEY=1002`, `AWAY_GOALS_KEY=1003`) instead of attacker-supplied init args — a griefer can no longer create an unsettleable market. |
| 4 | MED | ✅ Fixed | Added `void_market` (authority), `claim_refund` (full stake back on void), and `sweep_fees` (one-time rake withdrawal). `settle_with_proof` auto-voids when `winning_pool == 0` so the pool is refundable instead of stuck. Market now stores an `authority`. |
| 5 | MED | ✅ Fixed | `settle_with_proof` derives the expected `daily_scores_roots` PDA on-chain from the proven `ts` and `require_keys_eq!`s the passed account (`WrongDayRoot`) — no longer trusting txoracle alone. |
| 6 | LOW | ✅ Fixed | The native spike now pins the txoracle program id (`IncorrectProgramId`) + a loud "do not copy to prod" comment. |
| 7 | LOW | ✅ Addressed | Pro-rata dust is recoverable via `sweep_fees` (it stays with the rake slack in the vault). |
| 8 | LOW | ✅ Fixed | `keeper.mjs`, `e2e.mjs`, `gen_receipt.mjs` now resolve paths from `import.meta.url` — the README run steps work anywhere. |
| 9 | INFO | ✅ Noted | Stale `TXLINE_MINT` IDL constant already worked around; raised upstream in the API feedback. |

## On #2 — how we closed it without a finished-marker
TxLINE's *provable* stats are score counts (no provable "is_final" flag — `GameState`/`StatusId` live
in the feed, not the Merkle set). But the proof DOES carry `update_stats.max_timestamp`, and a score
no longer changes once the match ends. So requiring `max_timestamp >= min_final_ts` forces the keeper
to prove data captured after full time — which is the final score. No dispute window or finished-flag
needed. The one remaining assumption is "the match is over by `min_final_ts`"; we set that from the
real kickoff + match length and leave abnormal cases (long delays, abandonment) to the authority
`void` + refund path. A provable finished-flag from TxLINE would let us drop even that assumption —
raised as API feedback.
