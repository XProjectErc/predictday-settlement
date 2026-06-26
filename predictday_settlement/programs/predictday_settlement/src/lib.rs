// predictday_settlement — trustless 3-way (home/draw/away) prediction market settled by TxLINE proofs.
// Escrow mirrors wcinu-arena (MarketVault PDA holds SOL). settle_with_proof is PERMISSIONLESS:
// trust comes from the on-chain proof, not a signer. The program BUILDS the predicate from
// winning_option and binds the proof to this fixture + the canonical home/away goal stat keys, so a
// keeper cannot fake the winner. Hardened per code review (betting deadline, settle window, hardcoded
// stat keys, on-chain day-root binding, authority + void/refund/fee-sweep).
use anchor_lang::prelude::*;
use anchor_lang::system_program;

pub mod txoracle_cpi;
use txoracle_cpi::*;

declare_id!("FcJMEhND5sZNQh3KY7FHa7T9qicxa75f1463yJgGX8Qq");

// devnet TxLINE txoracle program (CPI target)
const TXORACLE_ID: Pubkey = Pubkey::new_from_array([
    86, 117, 159, 44, 144, 95, 120, 96, 200, 99, 119, 20, 191, 36, 145, 48, 157, 192, 113, 129, 81,
    63, 122, 36, 191, 62, 218, 248, 127, 119, 80, 3,
]);
const TAKE_RATE_BPS: u64 = 300; // 3% rake
const MARKET_SEED: &[u8] = b"market";
const VAULT_SEED: &[u8] = b"vault";
const POS_SEED: &[u8] = b"pos";
// TxLINE score-stat keys for total goals (home / away). Hardcoded so a griefer cannot create a
// market with mismatched keys that can never settle (review #3). period 4 = full-match Total.
const HOME_GOALS_KEY: u32 = 1002;
const AWAY_GOALS_KEY: u32 = 1003;

#[program]
pub mod predictday_settlement {
    use super::*;

    /// closes_at = betting deadline (kickoff). settle_after = earliest settlement (≈ full time).
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        closes_at: i64,
        settle_after: i64,
        min_final_ts: i64,
        nonce: u32,
    ) -> Result<()> {
        require!(closes_at > 0, SettleError::BadSchedule);
        require!(settle_after >= closes_at, SettleError::BadSchedule);
        require!(min_final_ts > 0, SettleError::BadSchedule);
        let m = &mut ctx.accounts.market;
        m.fixture_id = fixture_id;
        m.nonce = nonce;
        m.authority = ctx.accounts.payer.key();
        m.num_options = 3;
        m.status = MarketStatus::Open;
        m.winning_option = u8::MAX;
        m.total_pool = 0;
        m.option_pools = [0u64; 3];
        m.closes_at = closes_at;
        m.settle_after = settle_after;
        m.min_final_ts = min_final_ts;
        m.settled_at = 0;
        m.fees_collected = 0;
        m.fees_swept = false;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        ctx.accounts.vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, option_idx: u8, amount: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.status == MarketStatus::Open, SettleError::MarketNotOpen);
        // review #1: betting closes at kickoff — never bet on a result you can already know.
        require!(Clock::get()?.unix_timestamp < m.closes_at, SettleError::BettingClosed);
        require!((option_idx as usize) < m.num_options as usize, SettleError::BadOption);
        require!(amount > 0, SettleError::ZeroAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let m = &mut ctx.accounts.market;
        m.total_pool = m.total_pool.checked_add(amount).ok_or(SettleError::Overflow)?;
        m.option_pools[option_idx as usize] =
            m.option_pools[option_idx as usize].checked_add(amount).ok_or(SettleError::Overflow)?;

        let p = &mut ctx.accounts.position;
        p.user = ctx.accounts.user.key();
        p.fixture_id = m.fixture_id;
        p.option_amounts[option_idx as usize] =
            p.option_amounts[option_idx as usize].checked_add(amount).ok_or(SettleError::Overflow)?;
        p.bump = ctx.bumps.position;
        Ok(())
    }

    /// Permissionless settlement via TxLINE proof. winning_option in {0=home,1=draw,2=away}.
    /// stat_a = home goals (key 1002), stat_b = away goals (key 1003) — keeper supplies proof only.
    pub fn settle_with_proof(
        ctx: Context<SettleWithProof>,
        winning_option: u8,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: StatTerm,
    ) -> Result<()> {
        let (fixture_id, total_pool, num_options, settle_after, min_final_ts) = {
            let m = &ctx.accounts.market;
            (m.fixture_id, m.total_pool, m.num_options, m.settle_after, m.min_final_ts)
        };
        require!(ctx.accounts.market.status == MarketStatus::Open, SettleError::MarketNotOpen);
        // review #2: wall-clock gate — can't settle before the match should be over.
        require!(Clock::get()?.unix_timestamp >= settle_after, SettleError::TooEarlyToSettle);
        // review #2 (finality binding): the proven data must be captured at/after full time. Since a
        // score is final once the match ends and max_timestamp is Merkle-proven, requiring it >=
        // min_final_ts forces the keeper to prove the FINAL score — they can't settle on an earlier
        // (transient) seq. Abnormal over-runs/postponements are handled by the authority void path.
        require!(fixture_summary.update_stats.max_timestamp >= min_final_ts, SettleError::ScoreNotFinal);
        require!((winning_option as usize) < num_options as usize, SettleError::BadOption);
        require!(fixture_summary.fixture_id == fixture_id, SettleError::FixtureMismatch);
        require!(stat_a.stat_to_prove.key == HOME_GOALS_KEY, SettleError::StatKeyMismatch);
        require!(stat_b.stat_to_prove.key == AWAY_GOALS_KEY, SettleError::StatKeyMismatch);

        // review #5: derive the day-root PDA on-chain from the proven ts and assert the passed
        // account matches — don't merely trust txoracle to reject a wrong-day account.
        let epoch_day = (ts / 86_400_000) as u16;
        let ed = epoch_day.to_le_bytes();
        let day_seeds: &[&[u8]] = &[b"daily_scores_roots", &ed];
        let (expected_day, _) = Pubkey::find_program_address(day_seeds, &TXORACLE_ID);
        require_keys_eq!(
            ctx.accounts.daily_scores_merkle_roots.key(),
            expected_day,
            SettleError::WrongDayRoot
        );

        let comparison = match winning_option {
            0 => Comparison::GreaterThan, // home - away > 0
            1 => Comparison::EqualTo,     // == 0
            2 => Comparison::LessThan,    // < 0
            _ => return err!(SettleError::BadOption),
        };
        let args = ValidateStatArgs {
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            predicate: TraderPredicate { threshold: 0, comparison },
            stat_a,
            stat_b: Some(stat_b),
            op: Some(BinaryExpression::Subtract),
        };
        let won = cpi_validate_stat(
            &ctx.accounts.txoracle_program.to_account_info(),
            &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            args,
        )?;
        require!(won, SettleError::ProofRejected);

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        m.winning_option = winning_option;
        m.settled_at = now;
        // review #4: if nobody bet the actual winner, void for refunds instead of locking the pool.
        if m.option_pools[winning_option as usize] == 0 {
            m.status = MarketStatus::Voided;
            emit!(MarketVoided { fixture_id, reason_winner_empty: true });
        } else {
            let fees = (total_pool as u128)
                .checked_mul(TAKE_RATE_BPS as u128).ok_or(SettleError::Overflow)?
                .checked_div(10_000u128).ok_or(SettleError::Overflow)? as u64;
            m.status = MarketStatus::Settled;
            m.fees_collected = fees;
            emit!(SettledByProof { fixture_id, winning_option, total_pool, fees });
        }
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let (win, winning_pool, net_pool) = {
            let m = &ctx.accounts.market;
            require!(m.status == MarketStatus::Settled, SettleError::NotSettled);
            let win = m.winning_option as usize;
            (win, m.option_pools[win], m.total_pool.checked_sub(m.fees_collected).ok_or(SettleError::Overflow)?)
        };
        require!(!ctx.accounts.position.claimed, SettleError::AlreadyClaimed);
        let stake = ctx.accounts.position.option_amounts[win];
        require!(stake > 0, SettleError::NothingToClaim);
        require!(winning_pool > 0, SettleError::Overflow);

        let payout = (stake as u128)
            .checked_mul(net_pool as u128).ok_or(SettleError::Overflow)?
            .checked_div(winning_pool as u128).ok_or(SettleError::Overflow)? as u64;

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += payout;
        ctx.accounts.position.claimed = true;
        emit!(Claimed { fixture_id: ctx.accounts.market.fixture_id, user: ctx.accounts.user.key(), payout });
        Ok(())
    }

    /// review #4: authority can void an Open market (postponed/abandoned match) → refunds.
    pub fn void_market(ctx: Context<AdminMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, SettleError::MarketNotOpen);
        m.status = MarketStatus::Voided;
        m.settled_at = Clock::get()?.unix_timestamp;
        emit!(MarketVoided { fixture_id: m.fixture_id, reason_winner_empty: false });
        Ok(())
    }

    /// review #4: refund full stake on a voided market.
    pub fn claim_refund(ctx: Context<Claim>) -> Result<()> {
        require!(ctx.accounts.market.status == MarketStatus::Voided, SettleError::NotVoided);
        require!(!ctx.accounts.position.claimed, SettleError::AlreadyClaimed);
        let stake: u64 = ctx.accounts.position.option_amounts.iter().copied().sum();
        require!(stake > 0, SettleError::NothingToClaim);
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += stake;
        ctx.accounts.position.claimed = true;
        emit!(Refunded { fixture_id: ctx.accounts.market.fixture_id, user: ctx.accounts.user.key(), amount: stake });
        Ok(())
    }

    /// review #4: authority sweeps the accrued rake (exactly fees_collected, one-time) after settlement.
    /// Safe because winners are owed net_pool and the vault holds total_pool — fees_collected is the slack.
    /// NOTE (re #7): this does NOT recover pro-rata rounding dust or the vault rent — there is no
    /// vault-close ix, so those stay locked. Sub-lamport per winner; negligible, but not "recovered".
    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Settled, SettleError::NotSettled);
        require!(!m.fees_swept, SettleError::AlreadySwept);
        let fees = m.fees_collected;
        require!(fees > 0, SettleError::NothingToClaim);
        m.fees_swept = true;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= fees;
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += fees;
        Ok(())
    }
}

// ---------- state ----------
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketStatus {
    Open,
    Settled,
    Voided,
}

#[account]
pub struct Market {
    pub fixture_id: i64,        // 8
    pub nonce: u32,             // 4 (one fixture -> many markets, e.g. demo runs)
    pub authority: Pubkey,      // 32 (void / sweep_fees)
    pub num_options: u8,        // 1
    pub status: MarketStatus,   // 1
    pub winning_option: u8,     // 1
    pub total_pool: u64,        // 8
    pub option_pools: [u64; 3], // 24
    pub closes_at: i64,         // 8 (betting deadline / kickoff)
    pub settle_after: i64,      // 8 (earliest settlement, wall-clock ~ full time)
    pub min_final_ts: i64,      // 8 (ms) proven max_timestamp must be >= this => post-match = final score
    pub settled_at: i64,        // 8
    pub fees_collected: u64,    // 8
    pub fees_swept: bool,       // 1
    pub bump: u8,               // 1
    pub vault_bump: u8,         // 1
}
impl Market {
    pub const SPACE: usize = 8 + 8 + 4 + 32 + 1 + 1 + 1 + 8 + 24 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1;
}

#[account]
pub struct MarketVault {
    pub bump: u8,
}
impl MarketVault {
    pub const SPACE: usize = 8 + 1;
}

#[account]
pub struct Position {
    pub user: Pubkey,             // 32
    pub fixture_id: i64,          // 8
    pub option_amounts: [u64; 3], // 24
    pub claimed: bool,            // 1
    pub bump: u8,                 // 1
}
impl Position {
    pub const SPACE: usize = 8 + 32 + 8 + 24 + 1 + 1;
}

// ---------- contexts ----------
#[derive(Accounts)]
#[instruction(fixture_id: i64, closes_at: i64, settle_after: i64, min_final_ts: i64, nonce: u32)]
pub struct InitializeMarket<'info> {
    #[account(
        init, payer = payer, space = Market::SPACE,
        seeds = [MARKET_SEED, &fixture_id.to_le_bytes(), &nonce.to_le_bytes()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = payer, space = MarketVault::SPACE,
        seeds = [VAULT_SEED, &fixture_id.to_le_bytes(), &nonce.to_le_bytes()], bump
    )]
    pub vault: Account<'info, MarketVault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [VAULT_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.vault_bump)]
    pub vault: Account<'info, MarketVault>,
    #[account(
        init_if_needed, payer = user, space = Position::SPACE,
        seeds = [POS_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes(), user.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleWithProof<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: must be the TxLINE txoracle program
    #[account(address = TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: daily_scores roots PDA; key asserted on-chain against the derived PDA in the handler
    #[account(owner = TXORACLE_ID)]
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [VAULT_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.vault_bump)]
    pub vault: Account<'info, MarketVault>,
    #[account(
        mut, seeds = [POS_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes(), user.key().as_ref()], bump = position.bump,
        has_one = user @ SettleError::Unauthorized
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    #[account(
        mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.bump,
        has_one = authority @ SettleError::Unauthorized
    )]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(
        mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.bump,
        has_one = authority @ SettleError::Unauthorized
    )]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [VAULT_SEED, &market.fixture_id.to_le_bytes(), &market.nonce.to_le_bytes()], bump = market.vault_bump)]
    pub vault: Account<'info, MarketVault>,
    pub authority: Signer<'info>,
    /// CHECK: fee recipient chosen by the authority
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

// ---------- events ----------
#[event]
pub struct SettledByProof { pub fixture_id: i64, pub winning_option: u8, pub total_pool: u64, pub fees: u64 }
#[event]
pub struct Claimed { pub fixture_id: i64, pub user: Pubkey, pub payout: u64 }
#[event]
pub struct MarketVoided { pub fixture_id: i64, pub reason_winner_empty: bool }
#[event]
pub struct Refunded { pub fixture_id: i64, pub user: Pubkey, pub amount: u64 }

// ---------- errors ----------
#[error_code]
pub enum SettleError {
    #[msg("market not open")] MarketNotOpen,
    #[msg("market not settled")] NotSettled,
    #[msg("market not voided")] NotVoided,
    #[msg("bad option index")] BadOption,
    #[msg("amount must be > 0")] ZeroAmount,
    #[msg("betting is closed (kickoff passed)")] BettingClosed,
    #[msg("too early to settle (before settle_after)")] TooEarlyToSettle,
    #[msg("proven score is not final (max_timestamp < min_final_ts)")] ScoreNotFinal,
    #[msg("bad schedule (closes_at/settle_after)")] BadSchedule,
    #[msg("fixture id mismatch")] FixtureMismatch,
    #[msg("stat key mismatch")] StatKeyMismatch,
    #[msg("wrong day-root account")] WrongDayRoot,
    #[msg("proof rejected by validate_stat")] ProofRejected,
    #[msg("already claimed")] AlreadyClaimed,
    #[msg("nothing to claim")] NothingToClaim,
    #[msg("fees already swept")] AlreadySwept,
    #[msg("unauthorized")] Unauthorized,
    #[msg("overflow")] Overflow,
}
