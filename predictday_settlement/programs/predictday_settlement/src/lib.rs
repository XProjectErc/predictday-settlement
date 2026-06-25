// predictday_settlement — trustless 3-way (home/draw/away) prediction market settled by TxLINE Merkle proofs.
// Escrow mirrors wcinu-arena (MarketVault PDA holds SOL). settle_with_proof is PERMISSIONLESS:
// trust comes from the on-chain proof, not a signer. The program BUILDS the predicate from winning_option
// and binds the proof to this fixture + the correct home/away stat keys, so a keeper cannot fake the winner.
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

#[program]
pub mod predictday_settlement {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        home_stat_key: u32,
        away_stat_key: u32,
        closes_at: i64,
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.fixture_id = fixture_id;
        m.home_stat_key = home_stat_key;
        m.away_stat_key = away_stat_key;
        m.num_options = 3;
        m.status = MarketStatus::Open;
        m.winning_option = u8::MAX;
        m.total_pool = 0;
        m.option_pools = [0u64; 3];
        m.closes_at = closes_at;
        m.settled_at = 0;
        m.fees_collected = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        ctx.accounts.vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, option_idx: u8, amount: u64) -> Result<()> {
        require!(ctx.accounts.market.status == MarketStatus::Open, SettleError::MarketNotOpen);
        require!((option_idx as usize) < ctx.accounts.market.num_options as usize, SettleError::BadOption);
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
    /// stat_a = home goals, stat_b = away goals (keeper supplies proof material; program controls the rest).
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
        let (fixture_id, home_key, away_key, total_pool, num_options) = {
            let m = &ctx.accounts.market;
            (m.fixture_id, m.home_stat_key, m.away_stat_key, m.total_pool, m.num_options)
        };
        require!(ctx.accounts.market.status == MarketStatus::Open, SettleError::MarketNotOpen);
        require!((winning_option as usize) < num_options as usize, SettleError::BadOption);
        // bind the proof to THIS fixture and the correct stats — keeper cannot mislabel
        require!(fixture_summary.fixture_id == fixture_id, SettleError::FixtureMismatch);
        require!(stat_a.stat_to_prove.key == home_key, SettleError::StatKeyMismatch);
        require!(stat_b.stat_to_prove.key == away_key, SettleError::StatKeyMismatch);

        // program-controlled predicate over (home - away)
        let comparison = match winning_option {
            0 => Comparison::GreaterThan, // home - away > 0  -> home win
            1 => Comparison::EqualTo,     // home - away == 0 -> draw
            2 => Comparison::LessThan,    // home - away < 0  -> away win
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

        let fees = (total_pool as u128)
            .checked_mul(TAKE_RATE_BPS as u128).ok_or(SettleError::Overflow)?
            .checked_div(10_000u128).ok_or(SettleError::Overflow)? as u64;

        let m = &mut ctx.accounts.market;
        m.status = MarketStatus::Settled;
        m.winning_option = winning_option;
        m.fees_collected = fees;
        m.settled_at = Clock::get()?.unix_timestamp;
        emit!(SettledByProof { fixture_id, winning_option, total_pool, fees });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let (win, winning_pool, net_pool, fixture_id) = {
            let m = &ctx.accounts.market;
            require!(m.status == MarketStatus::Settled, SettleError::NotSettled);
            let win = m.winning_option as usize;
            (
                win,
                m.option_pools[win],
                m.total_pool.checked_sub(m.fees_collected).ok_or(SettleError::Overflow)?,
                m.fixture_id,
            )
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
        emit!(Claimed { fixture_id, user: ctx.accounts.user.key(), payout });
        Ok(())
    }
}

// ---------- state ----------
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketStatus {
    Open,
    Settled,
}

#[account]
pub struct Market {
    pub fixture_id: i64,        // 8
    pub home_stat_key: u32,     // 4
    pub away_stat_key: u32,     // 4
    pub num_options: u8,        // 1
    pub status: MarketStatus,   // 1
    pub winning_option: u8,     // 1
    pub total_pool: u64,        // 8
    pub option_pools: [u64; 3], // 24
    pub closes_at: i64,         // 8
    pub settled_at: i64,        // 8
    pub fees_collected: u64,    // 8
    pub bump: u8,               // 1
    pub vault_bump: u8,         // 1
}
impl Market {
    pub const SPACE: usize = 8 + 8 + 4 + 4 + 1 + 1 + 1 + 8 + 24 + 8 + 8 + 8 + 1 + 1;
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
#[instruction(fixture_id: i64)]
pub struct InitializeMarket<'info> {
    #[account(
        init, payer = payer, space = Market::SPACE,
        seeds = [MARKET_SEED, &fixture_id.to_le_bytes()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = payer, space = MarketVault::SPACE,
        seeds = [VAULT_SEED, &fixture_id.to_le_bytes()], bump
    )]
    pub vault: Account<'info, MarketVault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [VAULT_SEED, &market.fixture_id.to_le_bytes()], bump = market.vault_bump)]
    pub vault: Account<'info, MarketVault>,
    #[account(
        init_if_needed, payer = user, space = Position::SPACE,
        seeds = [POS_SEED, &market.fixture_id.to_le_bytes(), user.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleWithProof<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: must be the TxLINE txoracle program
    #[account(address = TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: daily_scores roots PDA; txoracle validates its discriminator+owner internally
    #[account(owner = TXORACLE_ID)]
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [VAULT_SEED, &market.fixture_id.to_le_bytes()], bump = market.vault_bump)]
    pub vault: Account<'info, MarketVault>,
    #[account(
        mut, seeds = [POS_SEED, &market.fixture_id.to_le_bytes(), user.key().as_ref()], bump = position.bump,
        has_one = user @ SettleError::Unauthorized
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
}

// ---------- events ----------
#[event]
pub struct SettledByProof {
    pub fixture_id: i64,
    pub winning_option: u8,
    pub total_pool: u64,
    pub fees: u64,
}
#[event]
pub struct Claimed {
    pub fixture_id: i64,
    pub user: Pubkey,
    pub payout: u64,
}

// ---------- errors ----------
#[error_code]
pub enum SettleError {
    #[msg("market not open")] MarketNotOpen,
    #[msg("market not settled")] NotSettled,
    #[msg("bad option index")] BadOption,
    #[msg("amount must be > 0")] ZeroAmount,
    #[msg("fixture id mismatch")] FixtureMismatch,
    #[msg("stat key mismatch")] StatKeyMismatch,
    #[msg("proof rejected by validate_stat")] ProofRejected,
    #[msg("already claimed")] AlreadyClaimed,
    #[msg("nothing to claim")] NothingToClaim,
    #[msg("unauthorized")] Unauthorized,
    #[msg("overflow")] Overflow,
}
