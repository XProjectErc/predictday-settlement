// M3: fetch stat-validation data, build validate_stat, simulate, inspect returnData.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
const { BN, Wallet, AnchorProvider, Program, web3 } = anchor;

const DIR = "/home/cross/txodds-spike";
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const API = "https://txline-dev.txodds.com";
const idl = JSON.parse(fs.readFileSync(`${DIR}/txline_idl.json`, "utf8"));
const auth = JSON.parse(fs.readFileSync(`${DIR}/auth.json`, "utf8"));
const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8"))));
const PROGRAM_ID = new PublicKey(idl.address);

// allow override via CLI: fixtureId seq statKey [statKey2]
const fixtureId = Number(process.argv[2] || 17952170);
const seq = Number(process.argv[3] || 941);
const statKey = Number(process.argv[4] || 1002);
const statKey2 = process.argv[5] ? Number(process.argv[5]) : null;

const conn = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
const program = new Program(idl, provider);

function H(path, params) {
  const u = new URL(API + path);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetch(u, { headers: { Authorization: `Bearer ${auth.jwt}`, "X-Api-Token": auth.apiToken } });
}

console.log(`stat-validation fixtureId=${fixtureId} seq=${seq} statKey=${statKey}${statKey2 ? " statKey2=" + statKey2 : ""}`);
const params = { fixtureId, seq, statKey };
if (statKey2) params.statKey2 = statKey2;
const r = await H("/api/scores/stat-validation", params);
const text = await r.text();
console.log("HTTP", r.status);
if (!r.ok) { console.log(text.slice(0, 500)); process.exit(1); }
const v = JSON.parse(text);
console.log("validation keys:", Object.keys(v).join(", "));

const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const fixtureSummary = {
  fixtureId: new BN(v.summary.fixtureId),
  updateStats: {
    updateCount: v.summary.updateStats.updateCount,
    minTimestamp: new BN(v.summary.updateStats.minTimestamp),
    maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
};
const fixtureProof = v.subTreeProof.map(node);
const mainTreeProof = v.mainTreeProof.map(node);
const stat1 = { statToProve: v.statToProve, eventStatRoot: v.eventStatRoot, statProof: v.statProof.map(node) };
let stat2 = null, op = null;
if (statKey2) { stat2 = { statToProve: v.statToProve2, eventStatRoot: v.eventStatRoot, statProof: v.statProof2.map(node) }; op = { subtract: {} }; }

// predicate: configurable via env to test true AND false branches
const TH = process.env.TH !== undefined ? Number(process.env.TH) : 0;
const CMP = process.env.CMP || "greaterThan"; // greaterThan | lessThan | equalTo ...
const predicate = { threshold: TH, comparison: { [CMP]: {} } };
console.log(`predicate: value ${CMP} ${TH}`);

const targetTs = Number(v.summary.updateStats.minTimestamp);
const epochDay = Math.floor(targetTs / 86400000);
const [dailyScoresPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
  PROGRAM_ID
);
const pdaInfo = await conn.getAccountInfo(dailyScoresPda);
console.log(`epochDay=${epochDay} dailyScoresPda=${dailyScoresPda.toBase58()} exists=${!!pdaInfo}`);

const ix = await program.methods
  .validateStat(new BN(targetTs), fixtureSummary, fixtureProof, mainTreeProof, predicate, stat1, stat2, op)
  .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
  .instruction();

const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(kp);

const sim = await conn.simulateTransaction(tx);
console.log("\n=== SIMULATION ===");
console.log("err:", JSON.stringify(sim.value.err));
console.log("unitsConsumed:", sim.value.unitsConsumed);
const rd = sim.value.returnData;
if (rd) {
  const raw = Buffer.from(rd.data[0], "base64");
  console.log("returnData.programId:", rd.programId);
  console.log("returnData raw bytes:", [...raw], "-> bool:", raw.length ? raw[0] === 1 : null);
} else {
  console.log("returnData: NONE (program did not set_return_data)");
}
console.log("\n--- logs ---");
console.log((sim.value.logs || []).join("\n"));
