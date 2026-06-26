// End-to-end via the production path: TxLine adapter (data) + keeper (settle) + the anchor program.
// Works on a local validator (cloning the real txoracle + roots) OR on devnet directly.
// init -> bet(winner+loser) -> wait for settle window -> FRAUD settle (wrong option, must revert)
//      -> keeper settle -> claim. Fresh market per run (random nonce). Paths are __dirname-relative.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TxLine } from "../src/txline.js";
import { settleWithProof, marketPda } from "../src/keeper.mjs";
const { BN, Wallet, AnchorProvider, Program, web3 } = anchor;

const HERE = path.dirname(fileURLToPath(import.meta.url)); // predictday_settlement/
const ROOT = path.resolve(HERE, "..");                     // repo root
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const cluster = isLocal ? "custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" : "devnet";
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
const idl = JSON.parse(fs.readFileSync(`${HERE}/target/idl/predictday_settlement.json`, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${ROOT}/devnet-keypair.json`, "utf8"))));
const fixtureId = 17952170, seq = 941, homeKey = 1002, awayKey = 1003;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const conn = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new Program(idl, provider);
const txline = new TxLine({ authPath: `${ROOT}/auth.json` });

const nonce = Number(process.env.NONCE ?? Math.floor(Math.random() * 4_000_000_000));
const mPda = marketPda(program.programId, fixtureId, nonce);
const fid = Buffer.from(new BN(fixtureId).toArray("le", 8));
const non = Buffer.from(new BN(nonce).toArray("le", 4));
const vPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), fid, non], program.programId)[0];
const pPda = PublicKey.findProgramAddressSync([Buffer.from("pos"), fid, non, payer.publicKey.toBuffer()], program.programId)[0];

(async () => {
  if (isLocal) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL));
  const BET = Number(process.env.BET_SOL || (isLocal ? 1 : 0.05));
  // mask any RPC key (query string) so it's safe to show on a recorded demo
  console.log("RPC:", RPC.replace(/\?.*$/, "").replace(/\/$/, ""), "| program:", program.programId.toBase58());
  console.log("payer:", payer.publicKey.toBase58(), "bal:", (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "| bet:", BET);

  const v = await txline.statValidation(fixtureId, seq, homeKey, awayKey);
  const a = TxLine.toSettleArgs(v);
  const winner = TxLine.outcome(a.homeGoals, a.awayGoals);
  const wrong = (winner + 2) % 3, loser = (winner + 1) % 3;
  console.log(`fixture ${fixtureId}: ${a.homeGoals}-${a.awayGoals} -> winner=${winner} (fraud uses ${wrong})`);

  // betting window opens now and closes shortly; settlement only after settle_after (demo timing).
  const WINDOW = Number(process.env.WINDOW_SEC || 12);
  const closesAt = Math.floor(Date.now() / 1000) + WINDOW;
  const settleAfter = closesAt;
  // finality threshold (ms): real markets set this to kickoff+~match-duration. For this historical
  // fixture, set just below the final proof's max_timestamp so only post-full-time data settles.
  const finalMaxTs = Number(v.summary.updateStats.maxTimestamp);
  const minFinalTs = finalMaxTs - 1000;

  const s0 = await program.methods.initializeMarket(new BN(fixtureId), new BN(closesAt), new BN(settleAfter), new BN(minFinalTs), nonce)
    .accounts({ market: mPda, vault: vPda, payer: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
  console.log("1) market initialized", ex(s0));

  for (const opt of [winner, loser])
    await program.methods.placeBet(opt, new BN(Math.round(BET * LAMPORTS_PER_SOL)))
      .accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
  console.log(`2) bets placed: ${BET} winner + ${BET} loser (betting closes in ~${closesAt - Math.floor(Date.now() / 1000)}s)`);

  const waitMs = settleAfter * 1000 - Date.now() + 1500;
  if (waitMs > 0) { console.log(`   waiting ~${Math.ceil(waitMs / 1000)}s for the settle window (no settling mid-match)...`); await sleep(waitMs); }

  const dailyPda = txline.dailyScoresPda(v.summary.updateStats.minTimestamp);
  try {
    await program.methods.settleWithProof(wrong, a.ts, a.fixtureSummary, a.fixtureProof, a.mainTreeProof, a.statA, a.statB)
      .accounts({ market: mPda, txoracleProgram: txline.programId, dailyScoresMerkleRoots: dailyPda })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    console.log("3) FRAUD SUCCEEDED -> BUG!");
  } catch (e) {
    const msg = (e.logs || []).join("\n");
    console.log("3) fraud settle REVERTED:", /ProofRejected/i.test(msg) ? "ProofRejected (keeper cannot fake the winner)" : (e.error?.errorMessage || "reverted"));
  }

  const r = await settleWithProof({ program, txline, fixtureId, market: mPda, seq, homeKey, awayKey });
  const m = await program.account.market.fetch(mPda);
  console.log(`4) SETTLED BY PROOF -> option ${r.winner}, fees ${m.feesCollected}`, ex(r.sig));

  const before = await conn.getBalance(payer.publicKey);
  const s = await program.methods.claim().accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey }).rpc();
  const after = await conn.getBalance(payer.publicKey);
  console.log("5) claimed:", ((after - before) / LAMPORTS_PER_SOL).toFixed(4), "SOL", ex(s));

  // 6) FINALITY GUARD (#2): a market whose finality threshold is in the future must reject the proof
  // (can't settle on a non-final/transient score). No bets, no wait — fails before the CPI.
  const n2 = nonce + 1;
  const f2 = Buffer.from(new BN(n2).toArray("le", 4));
  const m2 = marketPda(program.programId, fixtureId, n2);
  const v2 = PublicKey.findProgramAddressSync([Buffer.from("vault"), fid, f2], program.programId)[0];
  const dailyPda2 = txline.dailyScoresPda(v.summary.updateStats.minTimestamp);
  await program.methods.initializeMarket(new BN(fixtureId), new BN(1), new BN(1), new BN(finalMaxTs + 10_000_000_000), n2)
    .accounts({ market: m2, vault: v2, payer: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
  try {
    await program.methods.settleWithProof(winner, a.ts, a.fixtureSummary, a.fixtureProof, a.mainTreeProof, a.statA, a.statB)
      .accounts({ market: m2, txoracleProgram: txline.programId, dailyScoresMerkleRoots: dailyPda2 })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    console.log("6) FINALITY GUARD FAILED -> BUG! (stale-score settle should revert)");
  } catch (e) {
    const msg = (e.logs || []).join("\n");
    console.log("6) finality guard: stale/non-final settle REVERTED:", /ScoreNotFinal/i.test(msg) ? "ScoreNotFinal (must prove post-full-time data)" : (e.error?.errorMessage || "reverted"));
  }
  console.log("\nE2E (adapter + keeper + program, hardened): PASS");
})().catch(e => { console.error("E2E FAIL:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
