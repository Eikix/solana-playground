use anchor_lang::prelude::*;

/// Shared error codes reusable across experiments.
#[error_code]
pub enum CommonError {
    #[msg("Invalid input provided")]
    InvalidInput,
    #[msg("Arithmetic overflow")]
    Overflow,
}
