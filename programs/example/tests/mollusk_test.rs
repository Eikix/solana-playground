use mollusk_svm::Mollusk;
use mollusk_svm::program::keyed_account_for_system_program;
use mollusk_svm::result::Check;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_rent::Rent;

/// The program ID must match the `declare_id!` in the program source.
/// `5UeDXpRmJ9VW8vhnBVtTBTFmBS387T5fHSMQcVVDL2Q` decoded from base58.
const PROGRAM_ID_BYTES: [u8; 32] = [
    1, 37, 147, 231, 218, 185, 51, 192, 50, 245, 30, 84, 5, 117, 129, 208,
    75, 21, 69, 77, 52, 58, 0, 246, 131, 248, 123, 230, 204, 140, 57, 93,
];

/// Anchor discriminator for `initialize`: sha256("global:initialize")[..8]
const INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

/// Point Mollusk at the workspace's `target/deploy/` directory where
/// `anchor build` places the compiled .so files.
fn set_sbf_out_dir() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = std::path::Path::new(manifest_dir)
        .parent() // programs/
        .unwrap()
        .parent() // workspace root
        .unwrap();
    let deploy_dir = workspace_root.join("target").join("deploy");
    std::env::set_var("SBF_OUT_DIR", deploy_dir);
}

#[test]
fn test_initialize() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "example");

    let authority = Pubkey::new_unique();
    let (data_pda, _bump) = Pubkey::find_program_address(
        &[b"data", authority.as_ref()],
        &program_id,
    );

    let rent = Rent::default();
    // 8 (discriminator) + 32 (authority) + 8 (value) + 8 (last_slot) + 8 (last_timestamp) = 64
    let space: usize = 8 + 32 + 8 + 8 + 8;
    let _lamports = rent.minimum_balance(space);

    let value: u64 = 42;
    let mut ix_data = Vec::new();
    ix_data.extend_from_slice(&INITIALIZE_DISCRIMINATOR);
    ix_data.extend_from_slice(&value.to_le_bytes());

    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(data_pda, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(system_program_key, false),
        ],
        data: ix_data,
    };

    let authority_account = Account {
        lamports: 1_000_000_000,
        data: vec![],
        owner: system_program_key,
        executable: false,
        rent_epoch: 0,
    };

    let data_account = Account {
        lamports: 0,
        data: vec![],
        owner: system_program_key,
        executable: false,
        rent_epoch: 0,
    };

    mollusk.process_and_validate_instruction(
        &instruction,
        &[
            (data_pda, data_account),
            (authority, authority_account),
            (system_program_key, system_program_account),
        ],
        &[Check::success()],
    );
}
