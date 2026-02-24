use anchor_lang::prelude::*;

declare_id!("GEeGqsyMrqRBdBQwW4RsUeysWgp2RdRZnzBjMX11ozwi");

#[program]
pub mod recent_blockhash {
    use super::*;

    /// Read the most recent entry from the SlotHashes sysvar and log it.
    ///
    /// SlotHashes is serialized as:
    ///   [count: u64] [entries: (slot: u64, hash: [u8; 32])...]
    /// Each entry is 40 bytes. The first entry is the most recent.
    pub fn log_recent_hash(ctx: Context<LogRecentHash>) -> Result<()> {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;

        // Need at least 8 (count) + 40 (one entry) = 48 bytes
        require!(data.len() >= 48, RecentBlockhashError::NoSlotHashes);

        let count = u64::from_le_bytes(data[0..8].try_into().unwrap());
        msg!("SlotHashes entries: {}", count);

        // Parse the most recent entry
        let slot = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let hash = &data[16..48];

        msg!("Most recent slot: {}", slot);
        msg!("Blockhash: {:?}", hash);

        Ok(())
    }
}

#[derive(Accounts)]
pub struct LogRecentHash<'info> {
    /// CHECK: Validated by address constraint to be the SlotHashes sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[error_code]
pub enum RecentBlockhashError {
    #[msg("SlotHashes sysvar has no entries")]
    NoSlotHashes,
}
