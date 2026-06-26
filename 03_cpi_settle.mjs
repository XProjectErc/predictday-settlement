// M4: REAL devnet tx -> our settle_spike program -> CPI validate_stat -> gate release on returned bool.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
const { BN, Wallet, AnchorProvider, Program, web3 } = anchor;

const DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, ""); // this script's dir (repo root)
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const API = "https://txline-dev.txodds.com";
const idl = JSON.parse(fs.readFileSync(`${DIR}/txline_idl.json`, "utf8"));
const auth = JSON.parse(fs.readFileSync(`${DIR}/auth.json`, "utf8"));
const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8"))));
const TXORACLE = new PublicKey(idl.address);
const SETTLE_SPIKE = new PublicKey(fs.readFileSync(`${DIR}/cpi-program/PROGRAM_ID.txt`, "utf8").trim());

const fixtureId = 17952170, seq = 941, statKey = 1002;
const conn = new Connection(RPC, "confirmed");
const program = new Program(idl, new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));

const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
async function fetchValidation() {
  const u = new URL(API + "/api/scores/stat-validation");
  u.searchParams.set("fixtureId", fixtureId); u.searchParams.set("seq", seq); u.searchParams.set("statKey", statKey);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${auth.jwt}`, "X-Api-Token": auth.apiToken } });
  if (!r.ok) throw new Error("stat-validation HTTP " + r.status);
  return r.json();
}

// build the validate_stat instruction DATA (discriminator + borsh args) for a given predicate
async function validateStatData(v, predicate) {
  const fixtureSummary = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
  };
  const stat1 = { statToProve: v.statToProve, eventStatRoot: v.eventStatRoot, statProof: v.statProof.map(node) };
  const targetTs = Number(v.summary.updateStats.minTimestamp);
  const ix = await program.methods
    .validateStat(new BN(targetTs), fixtureSummary, v.subTreeProof.map(node), v.mainTreeProof.map(node), predicate, stat1, null, null)
    .accounts({ dailyScoresMerkleRoots: dailyPda(targetTs) })
    .instruction();
  return { data: ix.data, pda: dailyPda(targetTs) };
}
function dailyPda(targetTs) {
  const epochDay = Math.floor(targetTs / 86400000);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];
}

async function runCase(label, v, predicate) {
  console.log(`\n========== CASE: ${label} ==========`);
  const { data, pda } = await validateStatData(v, predicate);
  // our program: accounts [txoracle program, daily_scores pda]; instruction_data = validate_stat data
  const ix = new TransactionInstruction({
    programId: SETTLE_SPIKE,
    keys: [
      { pubkey: TXORACLE, isSigner: false, isWritable: false },
      { pubkey: pda, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
    console.log("TX CONFIRMED:", sig);
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    console.log("logs:\n" + (t.meta.logMessages || []).filter(l => /settle_spike|Predicate|RELEASED|return/i.test(l)).join("\n"));
    console.log("=> on-chain result: SETTLED/RELEASED");
  } catch (e) {
    const logs = (e.logs || e.transactionLogs || []);
    console.log("TX FAILED (expected for false predicate). relevant logs:");
    console.log(logs.filter(l => /settle_spike|Predicate|RELEASED|custom|failed/i.test(l)).join("\n") || e.message);
    console.log("=> on-chain result: REJECTED (escrow NOT released)");
  }
}

const v = await fetchValidation();
console.log("settle_spike:", SETTLE_SPIKE.toBase58(), " txoracle:", TXORACLE.toBase58());
await runCase("TRUE  (stat > 0)", v, { threshold: 0, comparison: { greaterThan: {} } });
await runCase("FALSE (stat > 999999)", v, { threshold: 999999, comparison: { greaterThan: {} } });
