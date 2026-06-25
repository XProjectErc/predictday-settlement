// M2 step 1: devnet wallet + free-tier on-chain subscribe + activate API token.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import nacl from "tweetnacl";

const { BN, Wallet, AnchorProvider, Program } = anchor;
const DIR = "/home/cross/txodds-spike";
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const API = "https://txline-dev.txodds.com"; // devnet API host
const idl = JSON.parse(fs.readFileSync(`${DIR}/txline_idl.json`, "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const TXLINE_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"); // verified from successful devnet subscribe txs (IDL const was stale)
const SERVICE_LEVEL_ID = 1;   // WC + Int Friendlies, 60s delay, FREE
const WEEKS = 4;
const LEAGUES = [];

const log = (...a) => console.log(...a);

// 1) persistent devnet keypair
const kpPath = `${DIR}/devnet-keypair.json`;
let kp;
if (fs.existsSync(kpPath)) {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
} else {
  kp = Keypair.generate();
  fs.writeFileSync(kpPath, JSON.stringify([...kp.secretKey]));
}
log("wallet:", kp.publicKey.toBase58());

const conn = new Connection(RPC, "confirmed");

// 2) fund
let bal = await conn.getBalance(kp.publicKey);
log("balance:", bal / LAMPORTS_PER_SOL, "SOL");
if (bal < 0.3 * LAMPORTS_PER_SOL) {
  try {
    log("requesting airdrop 1 SOL...");
    const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    bal = await conn.getBalance(kp.publicKey);
    log("balance after airdrop:", bal / LAMPORTS_PER_SOL, "SOL");
  } catch (e) {
    log("AIRDROP FAILED:", e.message, "\n>>> fund this address on devnet then re-run:", kp.publicKey.toBase58());
    if (bal === 0) process.exit(2);
  }
}

const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new Program(idl, provider);

// 3) derive subscribe accounts
const [pricingMatrix] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], PROGRAM_ID);
const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], PROGRAM_ID);
const tokenTreasuryVault = getAssociatedTokenAddressSync(TXLINE_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
const userTokenAccount = getAssociatedTokenAddressSync(TXLINE_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);
log("pricingMatrix:", pricingMatrix.toBase58());
log("tokenTreasuryPda:", tokenTreasuryPda.toBase58());
log("tokenTreasuryVault:", tokenTreasuryVault.toBase58());
log("userTokenAccount:", userTokenAccount.toBase58());

// sanity: do the prereq accounts exist on devnet?
for (const [n, pk] of [["pricingMatrix", pricingMatrix], ["tokenTreasuryPda", tokenTreasuryPda], ["tokenTreasuryVault", tokenTreasuryVault], ["TXLINE_MINT", TXLINE_MINT]]) {
  const ai = await conn.getAccountInfo(pk);
  log(`  exists ${n}: ${!!ai}${ai ? " owner=" + ai.owner.toBase58() : ""}`);
}

// 4) create user ATA (Token-2022) if needed
try {
  const ata = await createAssociatedTokenAccountIdempotent(conn, kp, TXLINE_MINT, kp.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  log("user ATA ready:", ata.toBase58());
} catch (e) {
  log("ATA create note:", e.message);
}

// 5) subscribe on-chain
let txSig;
try {
  txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, WEEKS)
    .accounts({
      user: kp.publicKey,
      pricingMatrix,
      tokenMint: TXLINE_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();
  log("SUBSCRIBE tx:", txSig);
} catch (e) {
  log("SUBSCRIBE FAILED:", e.message);
  if (e.logs) log(e.logs.join("\n"));
  process.exit(3);
}

// 6) guest JWT
const jwt = (await (await fetch(`${API}/auth/guest/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).token;
log("jwt:", jwt.slice(0, 24) + "...");

// 7) sign + activate
const messageString = `${txSig}:${LEAGUES.join(",")}:${jwt}`;
const sigBytes = nacl.sign.detached(new TextEncoder().encode(messageString), kp.secretKey);
const walletSignature = Buffer.from(sigBytes).toString("base64");
const actRes = await fetch(`${API}/api/token/activate`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ txSig, walletSignature, leagues: LEAGUES }),
});
const actText = await actRes.text();
log("activate HTTP", actRes.status, actText.slice(0, 300));
let apiToken;
try { const j = JSON.parse(actText); apiToken = j.token || j.apiToken || j; } catch { apiToken = actText; }

fs.writeFileSync(`${DIR}/auth.json`, JSON.stringify({ jwt, apiToken, txSig, wallet: kp.publicKey.toBase58() }, null, 2));
log("\nSaved auth.json. apiToken:", String(apiToken).slice(0, 24) + "...");
