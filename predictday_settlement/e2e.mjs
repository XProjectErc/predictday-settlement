// End-to-end via the production path: TxLine adapter (data) + keeper (settle) + the anchor program.
// Works on a local validator (cloning the real txoracle + roots) OR on devnet directly.
// init -> bet(winner+loser) -> FRAUD settle (wrong option, must revert) -> keeper settle -> claim.
// Idempotent + devnet-safe (small bets, no localnet airdrop), prints explorer links.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TxLine } from "../src/txline.js";
import { settleWithProof, marketPda } from "../src/keeper.mjs";
const { BN, Wallet, AnchorProvider, Program, web3 } = anchor;

const DIR = "/home/cross/txodds-spike";
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const cluster = isLocal ? "custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" : "devnet";
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
const idl = JSON.parse(fs.readFileSync(`${DIR}/predictday_settlement/target/idl/predictday_settlement.json`, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8"))));
const fixtureId = 17952170, seq = 941, homeKey = 1002, awayKey = 1003;

const conn = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new Program(idl, provider);
const txline = new TxLine({ authPath: `${DIR}/auth.json` });

// fresh nonce per run => a brand-new market each demo take (override with NONCE=…)
const nonce = Number(process.env.NONCE ?? Math.floor(Math.random() * 4_000_000_000));
const mPda = marketPda(program.programId, fixtureId, nonce);
const fid = Buffer.from(new BN(fixtureId).toArray("le", 8));
const non = Buffer.from(new BN(nonce).toArray("le", 4));
const vPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), fid, non], program.programId)[0];
const pPda = PublicKey.findProgramAddressSync([Buffer.from("pos"), fid, non, payer.publicKey.toBuffer()], program.programId)[0];

(async () => {
  if (isLocal) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL));
  const BET = Number(process.env.BET_SOL || (isLocal ? 1 : 0.05));
  console.log("RPC:", RPC, "| program:", program.programId.toBase58());
  console.log("payer:", payer.publicKey.toBase58(), "bal:", (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL, "| bet:", BET);

  const v = await txline.statValidation(fixtureId, seq, homeKey, awayKey);
  const a = TxLine.toSettleArgs(v);
  const winner = TxLine.outcome(a.homeGoals, a.awayGoals);
  const wrong = (winner + 2) % 3, loser = (winner + 1) % 3;
  console.log(`fixture ${fixtureId}: ${a.homeGoals}-${a.awayGoals} -> winner=${winner} (fraud uses ${wrong})`);

  // 1) init (skip if exists)
  let m = await program.account.market.fetchNullable(mPda);
  if (!m) {
    const s = await program.methods.initializeMarket(new BN(fixtureId), homeKey, awayKey, new BN(0), nonce)
      .accounts({ market: mPda, vault: vPda, payer: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
    console.log("1) market initialized", ex(s));
    m = await program.account.market.fetch(mPda);
  } else console.log("1) market exists, status:", Object.keys(m.status)[0]);

  // 2) bets (only on a fresh open market)
  if (Object.keys(m.status)[0] === "open" && m.totalPool.isZero()) {
    for (const opt of [winner, loser])
      await program.methods.placeBet(opt, new BN(Math.round(BET * LAMPORTS_PER_SOL)))
        .accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
    console.log(`2) bets placed: ${BET} on winner + ${BET} on loser`);
    m = await program.account.market.fetch(mPda);
  } else console.log("2) bets skipped (not fresh/open)");

  // 3+4) fraud revert, then real keeper settle
  if (Object.keys(m.status)[0] === "open") {
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
    m = await program.account.market.fetch(mPda);
    console.log(`4) SETTLED BY PROOF -> option ${r.winner}, fees ${m.feesCollected}`, ex(r.sig));
  } else console.log("3-4) already settled, winning_option:", m.winningOption);

  // 5) claim (skip if already claimed)
  const pos = await program.account.position.fetchNullable(pPda);
  if (pos && !pos.claimed) {
    const before = await conn.getBalance(payer.publicKey);
    const s = await program.methods.claim().accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey }).rpc();
    const after = await conn.getBalance(payer.publicKey);
    console.log("5) claimed:", ((after - before) / LAMPORTS_PER_SOL).toFixed(4), "SOL", ex(s));
  } else console.log("5) claim skipped (already claimed / no position)");
  console.log("\nE2E (adapter + keeper + program): PASS");
})().catch(e => { console.error("E2E FAIL:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
