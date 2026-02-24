use anchor_lang::prelude::*;

declare_id!("GEeGqsyMrqRBdBQwW4RsUeysWgp2RdRZnzBjMX11ozwi");

// ── SlotHashes zero-copy reader ─────────────────────────────────────

const HEADER_SIZE: usize = 8; // u64 count
const ENTRY_SIZE: usize = 40; // u64 slot + [u8; 32] hash

#[derive(Clone, Copy, Debug)]
pub struct SlotHashEntry {
    pub slot: u64,
    pub hash: [u8; 32],
}

/// Zero-copy reader over borrowed SlotHashes sysvar data.
/// Does not deserialize the whole sysvar — only parses the entries you access.
pub struct SlotHashesReader<'a> {
    data: &'a [u8],
    count: u64,
}

impl<'a> SlotHashesReader<'a> {
    pub fn new(data: &'a [u8]) -> std::result::Result<Self, RecentBlockhashError> {
        if data.len() < HEADER_SIZE {
            return Err(RecentBlockhashError::NoSlotHashes);
        }
        let count = u64::from_le_bytes(
            data[..HEADER_SIZE]
                .try_into()
                .map_err(|_| RecentBlockhashError::InvalidData)?,
        );
        let expected = HEADER_SIZE + (count as usize) * ENTRY_SIZE;
        if data.len() < expected {
            return Err(RecentBlockhashError::InvalidData);
        }
        Ok(Self { data, count })
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn get(&self, index: u64) -> std::result::Result<SlotHashEntry, RecentBlockhashError> {
        if index >= self.count {
            return Err(RecentBlockhashError::IndexOutOfBounds);
        }
        let offset = HEADER_SIZE + (index as usize) * ENTRY_SIZE;
        let slot = u64::from_le_bytes(
            self.data[offset..offset + 8]
                .try_into()
                .map_err(|_| RecentBlockhashError::InvalidData)?,
        );
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&self.data[offset + 8..offset + 40]);
        Ok(SlotHashEntry { slot, hash })
    }

    pub fn most_recent(&self) -> std::result::Result<SlotHashEntry, RecentBlockhashError> {
        self.get(0)
    }
}

// ── Program ─────────────────────────────────────────────────────────

#[program]
pub mod recent_blockhash {
    use super::*;

    pub fn log_recent_hash(ctx: Context<LogRecentHash>) -> Result<()> {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        let reader = SlotHashesReader::new(&data).map_err(|e| error!(e))?;

        msg!("SlotHashes entries: {}", reader.count());

        let entry = reader.most_recent().map_err(|e| error!(e))?;

        msg!("Most recent slot: {}", entry.slot);
        msg!("Blockhash: {:?}", entry.hash);

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
    #[msg("SlotHashes data is malformed")]
    InvalidData,
    #[msg("Entry index out of bounds")]
    IndexOutOfBounds,
}
