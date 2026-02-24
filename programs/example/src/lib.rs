use anchor_lang::prelude::*;

declare_id!("5UeDXpRmJ9VW8vhnBVtTBTFmBS387T5fHSMQcVVDL2Q");

#[program]
pub mod example {
    use super::*;

    /// Initialize a new data account with a value stored in a PDA.
    pub fn initialize(ctx: Context<Initialize>, value: u64) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;
        data_account.authority = ctx.accounts.authority.key();
        data_account.value = value;
        Ok(())
    }

    /// Read the Clock sysvar and log the current slot + timestamp.
    pub fn read_clock(ctx: Context<ReadClock>) -> Result<()> {
        let clock = Clock::get()?;
        msg!("Slot: {}, Timestamp: {}", clock.slot, clock.unix_timestamp);
        ctx.accounts.data_account.last_slot = clock.slot;
        ctx.accounts.data_account.last_timestamp = clock.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + DataAccount::INIT_SPACE,
        seeds = [b"data", authority.key().as_ref()],
        bump,
    )]
    pub data_account: Account<'info, DataAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReadClock<'info> {
    #[account(
        mut,
        seeds = [b"data", authority.key().as_ref()],
        bump,
        has_one = authority,
    )]
    pub data_account: Account<'info, DataAccount>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct DataAccount {
    pub authority: Pubkey,
    pub value: u64,
    pub last_slot: u64,
    pub last_timestamp: i64,
}
