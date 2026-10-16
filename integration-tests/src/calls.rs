use anyhow::{Context, Result};
use sp_crypto_hashing::blake2_256;
use subxt::dynamic::{self, Value};
use subxt_signer::sr25519::dev;

use crate::context::Client;

#[derive(Clone, Copy, Debug)]
pub enum ReferendaPallet {
    Governance,
    Fellowship,
}

impl ReferendaPallet {
    fn name(self) -> &'static str {
        match self {
            ReferendaPallet::Governance => "Referenda",
            ReferendaPallet::Fellowship => "FellowshipReferenda",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Origin {
    pub caller: &'static str,
    pub variant: &'static str,
}

pub const ROOT: Origin = Origin {
    caller: "system",
    variant: "Root",
};

impl Origin {
    pub fn governance_track(track: &'static str) -> Origin {
        match track {
            "Root" => ROOT,
            variant => Origin {
                caller: "Origins",
                variant,
            },
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ProposalReference {
    Lookup,
    Inline,
}

#[derive(Clone, Debug)]
pub struct ReferendumCalls {
    pub preimage: Option<String>,
    pub submit: String,
}

pub struct SubmittedReferendum {
    pub referendum_id: u32,
    pub block_number: u32,
}

pub fn hex_of(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn call_bytes(client: &Client, pallet: &str, call: &str, fields: Vec<Value>) -> Result<Vec<u8>> {
    client
        .tx()
        .call_data(&dynamic::tx(pallet, call, fields))
        .with_context(|| format!("failed to encode {pallet}.{call}"))
}

pub fn remark(client: &Client, text: &str) -> Result<Vec<u8>> {
    call_bytes(client, "System", "remark", vec![Value::from_bytes(text)])
}

pub fn authorize_upgrade(client: &Client) -> Result<Vec<u8>> {
    call_bytes(
        client,
        "System",
        "authorize_upgrade",
        vec![Value::from_bytes([1u8; 32])],
    )
}

pub fn authorize_upgrade_without_checks(client: &Client, code_hash: [u8; 32]) -> Result<Vec<u8>> {
    call_bytes(
        client,
        "System",
        "authorize_upgrade_without_checks",
        vec![Value::from_bytes(code_hash)],
    )
}

pub fn fellowship_core_approve(client: &Client, who: [u8; 32], rank: u16) -> Result<Vec<u8>> {
    call_bytes(
        client,
        "FellowshipCore",
        "approve",
        vec![Value::from_bytes(who), Value::u128(rank.into())],
    )
}

pub fn submit_call(
    client: &Client,
    pallet: ReferendaPallet,
    origin: Origin,
    proposal: Value,
) -> Result<String> {
    let bytes = call_bytes(
        client,
        pallet.name(),
        "submit",
        vec![
            Value::unnamed_variant(
                origin.caller,
                vec![Value::unnamed_variant(origin.variant, vec![])],
            ),
            proposal,
            Value::unnamed_variant("After", vec![Value::u128(0)]),
        ],
    )?;
    Ok(hex_of(&bytes))
}

pub fn lookup_proposal(hash: [u8; 32], len: u32) -> Value {
    Value::unnamed_variant(
        "Lookup",
        vec![Value::from_bytes(hash), Value::u128(len.into())],
    )
}

pub fn referendum_calls(
    client: &Client,
    pallet: ReferendaPallet,
    origin: Origin,
    proposal: &[u8],
    reference: ProposalReference,
) -> Result<ReferendumCalls> {
    match reference {
        ProposalReference::Lookup => Ok(ReferendumCalls {
            preimage: Some(hex_of(&call_bytes(
                client,
                "Preimage",
                "note_preimage",
                vec![Value::from_bytes(proposal)],
            )?)),
            submit: submit_call(
                client,
                pallet,
                origin,
                lookup_proposal(blake2_256(proposal), proposal.len() as u32),
            )?,
        }),
        ProposalReference::Inline => Ok(ReferendumCalls {
            preimage: None,
            submit: submit_call(
                client,
                pallet,
                origin,
                Value::unnamed_variant("Inline", vec![Value::from_bytes(proposal)]),
            )?,
        }),
    }
}

struct RawCallData(Vec<u8>);

impl subxt::tx::Payload for RawCallData {
    fn encode_call_data_to(
        &self,
        _metadata: &subxt::Metadata,
        out: &mut Vec<u8>,
    ) -> std::result::Result<(), subxt::ext::subxt_core::Error> {
        out.extend_from_slice(&self.0);
        Ok(())
    }
}

fn decoded_hex(hex_call: &str) -> Result<Vec<u8>> {
    hex::decode(hex_call.trim_start_matches("0x"))
        .with_context(|| format!("invalid call hex {hex_call}"))
}

pub async fn submit_referendum(
    client: &Client,
    pallet: ReferendaPallet,
    calls: &ReferendumCalls,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();
    if let Some(preimage) = &calls.preimage {
        client
            .tx()
            .sign_and_submit_then_watch_default(&RawCallData(decoded_hex(preimage)?), &alice)
            .await
            .context("failed to submit Preimage.note_preimage")?
            .wait_for_finalized_success()
            .await
            .context("Preimage.note_preimage failed")?;
    }
    let submission = client
        .tx()
        .sign_and_submit_then_watch_default(&RawCallData(decoded_hex(&calls.submit)?), &alice)
        .await
        .with_context(|| format!("failed to submit {}.submit", pallet.name()))?
        .wait_for_finalized()
        .await
        .with_context(|| format!("{}.submit not finalized", pallet.name()))?;
    let block_number = client.blocks().at(submission.block_hash()).await?.number();
    submission
        .wait_for_success()
        .await
        .with_context(|| format!("{}.submit failed", pallet.name()))?;

    let referendum_count = client
        .storage()
        .at_latest()
        .await?
        .fetch(&dynamic::storage(pallet.name(), "ReferendumCount", ()))
        .await?
        .with_context(|| format!("no {}.ReferendumCount", pallet.name()))?
        .as_type::<u32>()?;
    let referendum_id = referendum_count - 1;
    log::info!(
        "{} referendum #{referendum_id} submitted at block #{block_number}",
        pallet.name()
    );
    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}
