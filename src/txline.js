// TxLINE adapter — the primary data source for predict.day settlement.
// Wraps the txoracle free World Cup tier: on-chain subscribe + activate, scores/odds/fixtures,
// the 3-stage Merkle stat-validation bundle (what settle_with_proof needs), and the live SSE scores stream.
// ESM module. Auth is cached to disk and re-established on 401.
import fs from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import nacl from "tweetnacl";
const { BN, Wallet, AnchorProvider, Program } = anchor;

// devnet defaults (mainnet: api base https://txline.txodds.com + the mainnet program/mint)
export const DEVNET = {
  api: "https://txline-dev.txodds.com",
  rpc: "https://api.devnet.solana.com",
  programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  txlineMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG", // verified on-chain (IDL const is stale)
  serviceLevel: 1, // 1 = WC+friendlies 60s delay (free); 12 = realtime (free)
};

export class TxLine {
  constructor(opts = {}) {
    this.api = opts.api || DEVNET.api;
    this.rpc = opts.rpc || DEVNET.rpc;
    this.programId = new PublicKey(opts.programId || DEVNET.programId);
    this.txlineMint = new PublicKey(opts.txlineMint || DEVNET.txlineMint);
    this.serviceLevel = opts.serviceLevel ?? DEVNET.serviceLevel;
    this.leagues = opts.leagues || [];
    this.authPath = opts.authPath || null; // cache file
    this.idl = opts.idl || null; // required only for (re)subscribe
    this.keypair = opts.keypair || null; // required only for (re)subscribe
    this.auth = null;
  }

  // ---- auth ----
  _loadCachedAuth() {
    if (this.auth) return this.auth;
    if (this.authPath && fs.existsSync(this.authPath)) {
      this.auth = JSON.parse(fs.readFileSync(this.authPath, "utf8"));
    }
    return this.auth;
  }
  get headers() {
    const a = this._loadCachedAuth();
    if (!a) throw new Error("not authenticated — call ensureAuth()");
    return { Authorization: `Bearer ${a.jwt}`, "X-Api-Token": a.apiToken };
  }

  // Ensure we have a working apiToken; (re)subscribe+activate if missing or rejected.
  async ensureAuth() {
    const a = this._loadCachedAuth();
    if (a?.apiToken) {
      // cheap probe: a malformed stat-validation still authenticates (401 => bad token)
      const probe = await fetch(`${this.api}/api/scores/snapshot/0?asOf=1`, { headers: this.headers });
      if (probe.status !== 401) return this.auth;
    }
    return this.reauth();
  }

  async reauth() {
    if (!this.idl || !this.keypair) throw new Error("reauth needs { idl, keypair }");
    const conn = new Connection(this.rpc, "confirmed");
    const provider = new AnchorProvider(conn, new Wallet(this.keypair), { commitment: "confirmed" });
    const program = new Program(this.idl, provider);
    const pid = this.programId;
    const [pricingMatrix] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], pid);
    const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], pid);
    const treasuryVault = getAssociatedTokenAddressSync(this.txlineMint, treasuryPda, true, TOKEN_2022_PROGRAM_ID);
    const userAta = getAssociatedTokenAddressSync(this.txlineMint, this.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await createAssociatedTokenAccountIdempotent(conn, this.keypair, this.txlineMint, this.keypair.publicKey, {}, TOKEN_2022_PROGRAM_ID).catch(() => {});
    const txSig = await program.methods.subscribe(this.serviceLevel, 4).accounts({
      user: this.keypair.publicKey, pricingMatrix, tokenMint: this.txlineMint, userTokenAccount: userAta,
      tokenTreasuryVault: treasuryVault, tokenTreasuryPda: treasuryPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).rpc();
    const jwt = (await (await fetch(`${this.api}/auth/guest/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).token;
    const msg = `${txSig}:${this.leagues.join(",")}:${jwt}`;
    const walletSignature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), this.keypair.secretKey)).toString("base64");
    const res = await fetch(`${this.api}/api/token/activate`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ txSig, walletSignature, leagues: this.leagues }),
    });
    const txt = await res.text();
    let apiToken; try { const j = JSON.parse(txt); apiToken = j.token || j.apiToken || j; } catch { apiToken = txt; }
    if (!res.ok) throw new Error(`activate failed HTTP ${res.status}: ${txt.slice(0, 200)}`);
    this.auth = { jwt, apiToken, txSig, wallet: this.keypair.publicKey.toBase58() };
    if (this.authPath) fs.writeFileSync(this.authPath, JSON.stringify(this.auth, null, 2));
    return this.auth;
  }

  // ---- data ----
  async _get(path, params) {
    const u = new URL(this.api + path);
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    const r = await fetch(u, { headers: this.headers });
    if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  fixturesSnapshot(epochDay) { return this._get(`/api/fixtures/snapshot`, epochDay != null ? { epochDay } : null); }
  scoresSnapshot(fixtureId, asOf = Date.now()) { return this._get(`/api/scores/snapshot/${fixtureId}`, { asOf }); }
  scoresUpdates(epochDay, hour, interval) { return this._get(`/api/scores/updates/${epochDay}/${hour}/${interval}`); }

  // The 3-stage Merkle bundle for one (or two) score stat(s) — exactly what settle_with_proof consumes.
  statValidation(fixtureId, seq, statKey, statKey2 = null) {
    return this._get(`/api/scores/stat-validation`, { fixtureId, seq, statKey, statKey2 });
  }

  // live scores SSE — async generator yielding parsed lines
  async *streamScores(signal) {
    const res = await fetch(`${this.api}/api/scores/stream`, {
      headers: { ...this.headers, Accept: "text/event-stream", "Cache-Control": "no-cache" }, signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) if (line.trim()) yield line.trim();
    }
  }

  // ---- helpers ----
  // daily_scores_roots PDA the validator reads (epoch day from min update timestamp, ms)
  dailyScoresPda(minTimestampMs) {
    const epochDay = Math.floor(Number(minTimestampMs) / 86400000);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], this.programId)[0];
  }

  // Map a stat-validation bundle (with home + away stats) into the settle_with_proof anchor args.
  static toSettleArgs(v) {
    const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
    return {
      ts: new BN(v.summary.updateStats.minTimestamp),
      fixtureSummary: {
        fixtureId: new BN(v.summary.fixtureId),
        updateStats: {
          updateCount: v.summary.updateStats.updateCount,
          minTimestamp: new BN(v.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
      },
      fixtureProof: v.subTreeProof.map(node),
      mainTreeProof: v.mainTreeProof.map(node),
      statA: { statToProve: v.statToProve, eventStatRoot: v.eventStatRoot, statProof: v.statProof.map(node) },
      statB: { statToProve: v.statToProve2, eventStatRoot: v.eventStatRoot, statProof: v.statProof2.map(node) },
      homeGoals: v.statToProve.value,
      awayGoals: v.statToProve2.value,
    };
  }

  // 0=home win, 1=draw, 2=away win
  static outcome(homeGoals, awayGoals) {
    return homeGoals > awayGoals ? 0 : homeGoals === awayGoals ? 1 : 2;
  }
}

export default TxLine;
