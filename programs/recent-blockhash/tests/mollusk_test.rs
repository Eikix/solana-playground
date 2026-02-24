use mollusk_svm::result::Check;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

/// `GEeGqsyMrqRBdBQwW4RsUeysWgp2RdRZnzBjMX11ozwi` decoded from base58.
const PROGRAM_ID_BYTES: [u8; 32] = [
    226, 93, 255, 210, 16, 103, 4, 149, 169, 248, 46, 44, 65, 3, 201, 27, 195, 23, 110, 221, 181,
    220, 203, 16, 148, 135, 209, 236, 165, 59, 116, 25,
];

/// `SysvarS1otHashes111111111111111111111111111` decoded from base58.
const SLOT_HASHES_BYTES: [u8; 32] = [
    6, 167, 213, 23, 25, 47, 10, 175, 198, 242, 101, 227, 251, 119, 204, 122, 218, 130, 197, 41,
    208, 190, 59, 19, 110, 45, 0, 85, 32, 0, 0, 0,
];

/// sha256("global:log_recent_hash")[..8]
const LOG_RECENT_HASH_DISC: [u8; 8] = [252, 174, 104, 89, 199, 191, 29, 143];

fn set_sbf_out_dir() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let deploy_dir = workspace_root.join("target").join("deploy");
    std::env::set_var("SBF_OUT_DIR", deploy_dir);
}

/// Build a fake SlotHashes sysvar account with one entry.
fn build_slot_hashes_account(slot: u64, hash: [u8; 32]) -> Account {
    // Format: [count: u64 LE] [entry: (slot: u64 LE, hash: [u8; 32])...]
    let mut data = Vec::with_capacity(48);
    data.extend_from_slice(&1u64.to_le_bytes()); // count = 1
    data.extend_from_slice(&slot.to_le_bytes());
    data.extend_from_slice(&hash);

    Account {
        lamports: 1,
        data,
        owner: Pubkey::from(SLOT_HASHES_BYTES),
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn test_log_recent_hash() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "recent_blockhash");

    let slot_hashes_key = Pubkey::from(SLOT_HASHES_BYTES);

    let test_slot: u64 = 12345;
    let test_hash: [u8; 32] = [0xAB; 32];
    let slot_hashes_account = build_slot_hashes_account(test_slot, test_hash);

    let instruction = Instruction {
        program_id,
        accounts: vec![AccountMeta::new_readonly(slot_hashes_key, false)],
        data: LOG_RECENT_HASH_DISC.to_vec(),
    };

    mollusk.process_and_validate_instruction(
        &instruction,
        &[(slot_hashes_key, slot_hashes_account)],
        &[Check::success()],
    );
}
