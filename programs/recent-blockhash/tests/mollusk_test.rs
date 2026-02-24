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

/// Build a fake SlotHashes sysvar account with N entries.
fn build_slot_hashes_account(entries: &[(u64, [u8; 32])]) -> Account {
    let mut data = Vec::with_capacity(8 + entries.len() * 40);
    data.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    for (slot, hash) in entries {
        data.extend_from_slice(&slot.to_le_bytes());
        data.extend_from_slice(hash);
    }
    Account {
        lamports: 1,
        data,
        owner: Pubkey::from(SLOT_HASHES_BYTES),
        executable: false,
        rent_epoch: 0,
    }
}

fn build_instruction(program_id: Pubkey) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![AccountMeta::new_readonly(
            Pubkey::from(SLOT_HASHES_BYTES),
            false,
        )],
        data: LOG_RECENT_HASH_DISC.to_vec(),
    }
}

// ── On-chain (SBF) tests via Mollusk ──

#[test]
fn test_single_entry() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "recent_blockhash");
    let slot_hashes_key = Pubkey::from(SLOT_HASHES_BYTES);

    let account = build_slot_hashes_account(&[(12345, [0xAB; 32])]);

    mollusk.process_and_validate_instruction(
        &build_instruction(program_id),
        &[(slot_hashes_key, account)],
        &[Check::success()],
    );
}

#[test]
fn test_multiple_entries_reads_most_recent() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "recent_blockhash");
    let slot_hashes_key = Pubkey::from(SLOT_HASHES_BYTES);

    let account =
        build_slot_hashes_account(&[(300, [0xCC; 32]), (200, [0xBB; 32]), (100, [0xAA; 32])]);

    mollusk.process_and_validate_instruction(
        &build_instruction(program_id),
        &[(slot_hashes_key, account)],
        &[Check::success()],
    );
}

#[test]
fn test_empty_sysvar_fails() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "recent_blockhash");
    let slot_hashes_key = Pubkey::from(SLOT_HASHES_BYTES);

    // count = 0, no entries
    let account = build_slot_hashes_account(&[]);

    // count=0 is structurally valid, but most_recent() hits IndexOutOfBounds (6002)
    mollusk.process_and_validate_instruction(
        &build_instruction(program_id),
        &[(slot_hashes_key, account)],
        &[Check::err(solana_program_error::ProgramError::Custom(6002))],
    );
}

#[test]
fn test_truncated_data_fails() {
    set_sbf_out_dir();

    let program_id = Pubkey::from(PROGRAM_ID_BYTES);
    let mollusk = Mollusk::new(&program_id, "recent_blockhash");
    let slot_hashes_key = Pubkey::from(SLOT_HASHES_BYTES);

    // count says 1 entry but data is too short
    let mut data = Vec::new();
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&[0u8; 20]); // 20 bytes, need 40
    let account = Account {
        lamports: 1,
        data,
        owner: Pubkey::from(SLOT_HASHES_BYTES),
        executable: false,
        rent_epoch: 0,
    };

    // Anchor error 6001 = InvalidData → ProgramError::Custom(6001)
    mollusk.process_and_validate_instruction(
        &build_instruction(program_id),
        &[(slot_hashes_key, account)],
        &[Check::err(solana_program_error::ProgramError::Custom(6001))],
    );
}

// ── Unit tests for SlotHashesReader (no SBF, pure Rust) ──

use recent_blockhash::SlotHashesReader;

fn make_sysvar_bytes(entries: &[(u64, [u8; 32])]) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + entries.len() * 40);
    data.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    for (slot, hash) in entries {
        data.extend_from_slice(&slot.to_le_bytes());
        data.extend_from_slice(hash);
    }
    data
}

#[test]
fn reader_parses_single_entry() {
    let data = make_sysvar_bytes(&[(42, [0xFF; 32])]);
    let reader = SlotHashesReader::new(&data).unwrap();

    assert_eq!(reader.count(), 1);
    let entry = reader.most_recent().unwrap();
    assert_eq!(entry.slot, 42);
    assert_eq!(entry.hash, [0xFF; 32]);
}

#[test]
fn reader_parses_multiple_and_indexes_correctly() {
    let entries = [(300, [0xCC; 32]), (200, [0xBB; 32]), (100, [0xAA; 32])];
    let data = make_sysvar_bytes(&entries);
    let reader = SlotHashesReader::new(&data).unwrap();

    assert_eq!(reader.count(), 3);

    let e0 = reader.get(0).unwrap();
    assert_eq!(e0.slot, 300);
    assert_eq!(e0.hash, [0xCC; 32]);

    let e1 = reader.get(1).unwrap();
    assert_eq!(e1.slot, 200);
    assert_eq!(e1.hash, [0xBB; 32]);

    let e2 = reader.get(2).unwrap();
    assert_eq!(e2.slot, 100);
    assert_eq!(e2.hash, [0xAA; 32]);
}

#[test]
fn reader_rejects_empty_data() {
    assert!(SlotHashesReader::new(&[]).is_err());
}

#[test]
fn reader_zero_count_rejects_most_recent() {
    let data = make_sysvar_bytes(&[]);
    let reader = SlotHashesReader::new(&data).unwrap();
    assert_eq!(reader.count(), 0);
    assert!(reader.most_recent().is_err());
}

#[test]
fn reader_rejects_truncated_data() {
    let mut data = Vec::new();
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&[0u8; 20]); // too short for one entry
    assert!(SlotHashesReader::new(&data).is_err());
}

#[test]
fn reader_rejects_out_of_bounds_index() {
    let data = make_sysvar_bytes(&[(1, [0xAA; 32])]);
    let reader = SlotHashesReader::new(&data).unwrap();
    assert!(reader.get(1).is_err());
    assert!(reader.get(999).is_err());
}
