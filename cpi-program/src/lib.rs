// settle_spike — proves Architecture A on devnet:
// CPI into txoracle.validate_stat, read the bool via get_return_data(), gate "release" on it.
// instruction_data = the full validate_stat instruction data (anchor discriminator + borsh args),
// built client-side and forwarded verbatim (avoids re-declaring the complex arg types here).
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{get_return_data, invoke},
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let txoracle = next_account_info(account_iter)?; // executable program to CPI
    let daily = next_account_info(account_iter)?; // daily_scores_merkle_roots (readonly)

    msg!("settle_spike: CPI -> validate_stat on {}", txoracle.key);
    let ix = Instruction {
        program_id: *txoracle.key,
        accounts: vec![AccountMeta::new_readonly(*daily.key, false)],
        data: instruction_data.to_vec(),
    };
    invoke(&ix, &[daily.clone(), txoracle.clone()])?;

    let (ret_pid, ret) = get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    let won = ret.first().copied() == Some(1u8);
    msg!(
        "settle_spike: validate_stat (returned by {}) -> won={}",
        ret_pid,
        won
    );
    if !won {
        msg!("PREDICATE FALSE -> escrow NOT released");
        return Err(ProgramError::Custom(1));
    }
    msg!("PREDICATE TRUE -> ESCROW RELEASED (spike)");
    Ok(())
}
