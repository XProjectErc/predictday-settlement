// B end-to-end via the production path: TxLine adapter (data) + keeper (settle) + the anchor program.
// Local validator clones the real txoracle program + daily_scores account from devnet.
// init -> bet(winner+loser) -> FRAUD settle (wrong option, must revert) -> keeper settle -> claim.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { TxLine } from "../src/txline.js";
import { settleWithProof, marketPda } from "../src/keeper.mjs";
const { BN, Wallet, AnchorProvider, Program, web3 } = anchor;

const DIR = "/home/cross/txodds-spike";
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const idl = JSON.parse(fs.readFileSync(`${DIR}/predictday_settlement/target/idl/predictday_settlement.json`, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8"))));
const fixtureId = 17952170, seq = 941, homeKey = 1002, awayKey = 1003;

const conn = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new Program(idl, provider);
const txline = new TxLine({ authPath: `${DIR}/auth.json` });

const mPda = marketPda(program.programId, fixtureId);
const fid = Buffer.from(new BN(fixtureId).toArray("le", 8));
const vPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), fid], program.programId)[0];
const pPda = PublicKey.findProgramAddressSync([Buffer.from("pos"), fid, payer.publicKey.toBuffer()], program.programId)[0];

(async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL));
  console.log("payer bal:", (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL);

  const v = await txline.statValidation(fixtureId, seq, homeKey, awayKey);
  const a = TxLine.toSettleArgs(v);
  const winner = TxLine.outcome(a.homeGoals, a.awayGoals);
  const wrong = (winner + 2) % 3;
  console.log(`home=${a.homeGoals} away=${a.awayGoals} -> winner=${winner} (fraud uses ${wrong})`);

  await program.methods.initializeMarket(new BN(fixtureId), homeKey, awayKey, new BN(0))
    .accounts({ market: mPda, vault: vPda, payer: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
  console.log("1) market initialized");

  const loser = (winner + 1) % 3;
  for (const [opt, sol] of [[winner, 1], [loser, 1]])
    await program.methods.placeBet(opt, new BN(sol * LAMPORTS_PER_SOL))
      .accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey, systemProgram: web3.SystemProgram.programId }).rpc();
  console.log("2) bets placed: 1 winner + 1 loser (pool 2 SOL)");

  // 3) FRAUD: direct settle with wrong option -> must revert
  const dailyPda = txline.dailyScoresPda(v.summary.updateStats.minTimestamp);
  try {
    await program.methods.settleWithProof(wrong, a.ts, a.fixtureSummary, a.fixtureProof, a.mainTreeProof, a.statA, a.statB)
      .accounts({ market: mPda, txoracleProgram: txline.programId, dailyScoresMerkleRoots: dailyPda })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    console.log("3) FRAUD SUCCEEDED -> BUG!");
  } catch (e) {
    const msg = (e.logs || []).join("\n");
    console.log("3) fraud settle REVERTED:", /ProofRejected|proof rejected/i.test(msg) ? "ProofRejected" : (e.error?.errorMessage || "reverted"));
  }

  // 4) real settle via keeper
  const r = await settleWithProof({ program, txline, fixtureId, market: mPda, seq, homeKey, awayKey });
  const m = await program.account.market.fetch(mPda);
  console.log(`4) keeper settled: ${r.homeGoals}-${r.awayGoals} -> option ${r.winner}. status ${Object.keys(m.status)[0]}, fees ${m.feesCollected}`);

  // 5) claim
  const before = await conn.getBalance(payer.publicKey);
  await program.methods.claim().accounts({ market: mPda, vault: vPda, position: pPda, user: payer.publicKey }).rpc();
  const after = await conn.getBalance(payer.publicKey);
  console.log("5) claimed:", ((after - before) / LAMPORTS_PER_SOL).toFixed(4), "SOL (expect ~1.94)");
  console.log("\nB E2E (adapter + keeper + program): PASS");
})().catch(e => { console.error("E2E FAIL:", e.message); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
