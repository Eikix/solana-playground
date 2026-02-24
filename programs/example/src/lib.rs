use anchor_lang::prelude::*;

declare_id!("5UeDXpRmJ9VW8vhnBVtTBTFmBS387T5fHSMQcVVDL2Q");

#[program]
pub mod example {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
