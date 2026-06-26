// Settlement keeper — the production path that turns a finished TxLINE match into an on-chain settlement.
// Pulls the 3-stage Merkle proof via the TxLine adapter, derives the winner, and calls settle_with_proof.
// Trust is on-chain: the program rebuilds the predicate and verifies the proof, so the keeper is untrusted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TxLine } from "./txline.js";
const { BN, Wallet, AnchorProvider, Program } = anchor;

export function marketPda(programId, fixtureId, nonce = 0) {
  const fid = Buffer.from(new BN(fixtureId).toArray("le", 8));
  const non = Buffer.from(new BN(nonce).toArray("le", 4));
  return PublicKey.findProgramAddressSync([Buffer.from("market"), fid, non], programId)[0];
}

// Settle one market from a TxLINE stat-validation bundle. Returns { winner, sig, homeGoals, awayGoals }.
export async function settleWithProof({ program, txline, fixtureId, market, seq, homeKey = 1002, awayKey = 1003, computeUnits = 1_400_000 }) {
  const v = await txline.statValidation(fixtureId, seq, homeKey, awayKey);
  const a = TxLine.toSettleArgs(v);
  const winner = TxLine.outcome(a.homeGoals, a.awayGoals);
  const dailyPda = txline.dailyScoresPda(v.summary.updateStats.minTimestamp);
  const mkt = market || marketPda(program.programId, fixtureId);
  const sig = await program.methods
    .settleWithProof(winner, a.ts, a.fixtureSummary, a.fixtureProof, a.mainTreeProof, a.statA, a.statB)
    .accounts({ market: mkt, txoracleProgram: txline.programId, dailyScoresMerkleRoots: dailyPda })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })])
    .rpc();
  return { winner, sig, homeGoals: a.homeGoals, awayGoals: a.awayGoals, fixtureId };
}

// CLI: node src/keeper.mjs --rpc <url> --fixture 17952170 --seq 941 [--home 1002 --away 1003]
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // repo root
  const rpc = arg("rpc", "http://127.0.0.1:8899");
  const fixtureId = Number(arg("fixture", 17952170));
  const seq = Number(arg("seq", 941));
  const homeKey = Number(arg("home", 1002)), awayKey = Number(arg("away", 1003));
  const idl = JSON.parse(fs.readFileSync(`${DIR}/predictday_settlement/target/idl/predictday_settlement.json`, "utf8"));
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8"))));
  const provider = new AnchorProvider(new Connection(rpc, "confirmed"), new Wallet(kp), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const txline = new TxLine({ authPath: `${DIR}/auth.json` });
  await txline.ensureAuth().catch(() => {});
  const r = await settleWithProof({ program, txline, fixtureId, seq, homeKey, awayKey });
  console.log(`keeper settled fixture ${r.fixtureId}: ${r.homeGoals}-${r.awayGoals} -> option ${r.winner}. tx ${r.sig}`);
}
