// Generates a self-contained "Verifiable Resolution Receipt" page for a settled fixture.
// The page lets ANYONE re-verify the score on-chain client-side (simulateTransaction of validate_stat
// against the public devnet RPC) — no backend, no trust. We inline the prebuilt tx + receipt data.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { TxLine } from "./txline.js";
const { BN, Wallet, AnchorProvider, Program } = anchor;

const DIR = "/home/cross/txodds-spike";
const DEVNET_RPC = "https://api.devnet.solana.com";
const idl = JSON.parse(fs.readFileSync(`${DIR}/txline_idl.json`, "utf8")); // txoracle IDL (for building validate_stat)
const fixtureId = Number(process.argv[2] || 17952170);
const seq = Number(process.argv[3] || 941), homeKey = 1002, awayKey = 1003;

const txline = new TxLine({ authPath: `${DIR}/auth.json` });
const conn = new Connection(DEVNET_RPC, "confirmed");
const dummyKp = anchor.web3.Keypair.generate();
const program = new Program(idl, new AnchorProvider(conn, new Wallet(dummyKp), {}));
const TXORACLE = new PublicKey(idl.address);

const v = await txline.statValidation(fixtureId, seq, homeKey, awayKey);
const a = TxLine.toSettleArgs(v);
const winner = TxLine.outcome(a.homeGoals, a.awayGoals);
const outcomeLabel = ["HOME WIN", "DRAW", "AWAY WIN"][winner];
const dailyPda = txline.dailyScoresPda(v.summary.updateStats.minTimestamp);

// Build a validate_stat tx that asserts the actual outcome (home-away vs 0). Returns bool via return-data.
const comparison = winner === 0 ? { greaterThan: {} } : winner === 1 ? { equalTo: {} } : { lessThan: {} };
const predicate = { threshold: 0, comparison };
const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const ix = await program.methods
  .validateStat(a.ts, a.fixtureSummary, a.fixtureProof, a.mainTreeProof, predicate, a.statA, a.statB, { subtract: {} })
  .accounts({ dailyScoresMerkleRoots: dailyPda })
  .instruction();
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
// fee payer must be an existing devnet account for read-only simulate (no funds used)
const feePayer = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/devnet-keypair.json`, "utf8")))).publicKey;
tx.feePayer = feePayer;
tx.recentBlockhash = "11111111111111111111111111111111"; // replaced at verify time
const txB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

const hex = (arr) => Buffer.from(arr).toString("hex");
const receipt = {
  fixtureId, seq, homeGoals: a.homeGoals, awayGoals: a.awayGoals, winner, outcomeLabel,
  dailyPda: dailyPda.toBase58(), txoracle: TXORACLE.toBase58(),
  eventsSubTreeRoot: hex(v.summary.eventStatsSubTreeRoot),
  mainTreeRoot: hex(v.mainTreeProof[0].hash),
  rpc: DEVNET_RPC, txB64,
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Verifiable Resolution Receipt — predict.day</title>
<style>
  :root{--bg:#070b0e;--card:#0d141a;--green:#19f08a;--dim:#7d8b95;--line:#1b2730;--txt:#e7f0f3}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:28px}
  .wrap{max-width:760px;margin:0 auto}
  h1{font:600 20px/1.2 'Space Grotesk',system-ui,sans-serif;letter-spacing:.3px;margin:0 0 4px}
  .sub{color:var(--dim);margin:0 0 22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line)}
  .row:last-child{border-bottom:0}
  .k{color:var(--dim)} .v{text-align:right;word-break:break-all}
  .score{font:600 34px/1 'Space Grotesk',sans-serif;text-align:center;padding:8px 0}
  .badge{display:inline-block;background:rgba(25,240,138,.12);color:var(--green);border:1px solid var(--green);border-radius:999px;padding:4px 12px;font-weight:600}
  a{color:var(--green)}
  button{background:var(--green);color:#02110a;border:0;border-radius:9px;padding:12px 18px;font:600 15px/1 inherit;cursor:pointer;width:100%}
  button:disabled{opacity:.6;cursor:wait}
  pre{background:#060a0d;border:1px solid var(--line);border-radius:9px;padding:12px;overflow:auto;max-height:280px;color:var(--dim);white-space:pre-wrap;word-break:break-all}
  .ok{color:var(--green);font-weight:600} .bad{color:#ff6b6b;font-weight:600}
  .mono{font-size:12px;color:var(--dim)}
</style></head><body><div class="wrap">
  <h1>Verifiable Resolution Receipt</h1>
  <p class="sub">This market was settled by a TxLINE cryptographic proof, verified on-chain. Re-verify it yourself below — no backend, no trust.</p>
  <div class="card">
    <div class="score" id="score"></div>
    <div style="text-align:center;margin-bottom:6px"><span class="badge" id="outcome"></span></div>
  </div>
  <div class="card">
    <div class="row"><span class="k">Fixture ID</span><span class="v" id="fix"></span></div>
    <div class="row"><span class="k">TxLINE program (txoracle)</span><span class="v"><a id="orac" target="_blank"></a></span></div>
    <div class="row"><span class="k">Daily scores root PDA</span><span class="v"><a id="pda" target="_blank"></a></span></div>
    <div class="row"><span class="k">Events sub-tree root</span><span class="v mono" id="estr"></span></div>
    <div class="row"><span class="k">Main-tree root</span><span class="v mono" id="mtr"></span></div>
  </div>
  <div class="card">
    <button id="verify">Verify on-chain (independent)</button>
    <pre id="out" style="margin-top:14px;display:none"></pre>
  </div>
  <p class="mono">Verification simulates txoracle.validate_stat against the public devnet RPC. A return of 0x01 means the 3-stage Merkle proof checks out against the on-chain daily roots and the outcome predicate holds.</p>
</div>
<script>
const R = ${JSON.stringify(receipt)};
const ex = (a)=>'https://explorer.solana.com/address/'+a+'?cluster=devnet';
score.textContent = R.homeGoals + ' - ' + R.awayGoals;
outcome.textContent = R.outcomeLabel;
fix.textContent = R.fixtureId;
orac.textContent = R.txoracle; orac.href = ex(R.txoracle);
pda.textContent = R.dailyPda; pda.href = ex(R.dailyPda);
estr.textContent = R.eventsSubTreeRoot;
mtr.textContent = R.mainTreeRoot;
verify.onclick = async () => {
  verify.disabled = true; verify.textContent = 'Verifying on-chain...';
  out.style.display='block'; out.textContent='POST simulateTransaction -> '+R.rpc+'\\n';
  try {
    const res = await fetch(R.rpc, {method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'simulateTransaction',
        params:[R.txB64,{sigVerify:false,replaceRecentBlockhash:true,encoding:'base64'}]})});
    const j = await res.json();
    const val = j.result?.value || {};
    const rd = val.returnData?.data?.[0];
    const ok = rd ? (atob(rd).charCodeAt(0)===1) : false;
    out.textContent += '\\nreturnData: '+(rd||'(none)')+'  -> '+(ok?'TRUE':'FALSE')+'\\n\\n'+(val.logs||[]).join('\\n');
    const verdict = document.createElement('div');
    verdict.className = ok ? 'ok' : 'bad';
    verdict.style.marginTop='10px';
    verdict.textContent = ok ? '✔ VERIFIED on-chain: the score and outcome are cryptographically proven.' : '✘ verification did not return true';
    out.parentNode.appendChild(verdict);
  } catch(e){ out.textContent += '\\nerror: '+e.message; }
  verify.disabled=false; verify.textContent='Verify on-chain (independent)';
};
</script></body></html>`;

fs.mkdirSync(`${DIR}/app`, { recursive: true });
fs.writeFileSync(`${DIR}/app/verifiable-resolution.html`, html);
console.log(`wrote app/verifiable-resolution.html  (fixture ${fixtureId}: ${a.homeGoals}-${a.awayGoals} ${outcomeLabel})`);

// sanity: confirm the embedded tx simulates to TRUE on devnet right now
const sim = await conn.simulateTransaction(tx, undefined, false).catch(e => ({ value: { err: e.message } }));
const rd = sim.value?.returnData?.data?.[0];
console.log("embedded-tx devnet simulate -> returnData:", rd, "bool:", rd ? Buffer.from(rd, "base64")[0] === 1 : "n/a", "err:", JSON.stringify(sim.value?.err));
