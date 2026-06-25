// Typed CPI into the TxLINE `txoracle` program's `validate_stat` (read-only, returns bool via return-data).
// Types mirror the on-chain IDL exactly (field order + enum variant order = borsh layout). Verified on devnet.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    program_error::ProgramError,
};

// anchor discriminator of `validate_stat` (from on-chain IDL)
pub const VALIDATE_STAT_DISCM: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, Clone)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

/// CPI into validate_stat and read the returned bool. The TxLINE program verifies the
/// 3-stage Merkle proof against its own on-chain daily roots and sets return-data 0/1.
pub fn cpi_validate_stat<'a>(
    txoracle_program: &AccountInfo<'a>,
    daily_scores: &AccountInfo<'a>,
    args: ValidateStatArgs,
) -> Result<bool> {
    let mut data = VALIDATE_STAT_DISCM.to_vec();
    args.serialize(&mut data)?;
    let ix = Instruction {
        program_id: *txoracle_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores.key, false)],
        data,
    };
    invoke(&ix, &[daily_scores.clone(), txoracle_program.clone()])?;
    let (_pid, ret) = get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    Ok(ret.first().copied() == Some(1u8))
}
