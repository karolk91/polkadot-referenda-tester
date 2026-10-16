import { printForkEvents } from '../network/event-collector';
import { isEvent, type ParsedEvent } from '../utils/events';
import type { Logger } from '../utils/logger';
import {
  type BridgeKusamaSide,
  type BridgePolkadotSide,
  POLKADOT_TO_KUSAMA_PALLETS,
} from './bridge-pump';
import type { ForkEventLog } from './fork-event-log';

function eventCount(events: ParsedEvent[], section: string, method: string): number {
  return events.filter((event) => isEvent(event, section, method)).length;
}

function isProcessedSuccess(event: ParsedEvent): boolean {
  return (event.data as { success?: unknown } | null)?.success === true;
}

export async function verifyBridgeDelivery(
  polkadot: BridgePolkadotSide,
  kusama: BridgeKusamaSide,
  log: ForkEventLog,
  logger: Logger
): Promise<string[]> {
  logger.section('Bridge Delivery Verification');
  for (const fork of [polkadot.bridgeHub, kusama.bridgeHub, kusama.assetHub]) {
    await printForkEvents(fork, log.events(fork), logger);
  }

  const { outboundMessages, inboundMessages } = POLKADOT_TO_KUSAMA_PALLETS;
  const polkadotBridgeHub = polkadot.bridgeHub.info.label;
  const kusamaBridgeHub = kusama.bridgeHub.info.label;
  const kusamaAssetHub = kusama.assetHub.info.label;
  const kusamaBridgeHubEvents = log.events(kusama.bridgeHub);
  const assetHubEvents = log.events(kusama.assetHub);
  const processed = assetHubEvents.filter((event) => isEvent(event, 'MessageQueue', 'Processed'));
  const counts = {
    accepted: eventCount(log.events(polkadot.bridgeHub), outboundMessages, 'MessageAccepted'),
    received: eventCount(kusamaBridgeHubEvents, inboundMessages, 'MessagesReceived'),
    forwarded: eventCount(kusamaBridgeHubEvents, 'XcmpQueue', 'XcmpMessageSent'),
    bridgeHubFailures: eventCount(kusamaBridgeHubEvents, 'System', 'ExtrinsicFailed'),
    processedSuccess: processed.filter(isProcessedSuccess).length,
    processedFailure: processed.filter((event) => !isProcessedSuccess(event)).length,
    whitelisted: eventCount(assetHubEvents, 'Whitelist', 'CallWhitelisted'),
  };

  const failures = [
    counts.accepted === 0 &&
      `${polkadotBridgeHub}: expected at least one ${outboundMessages}.MessageAccepted event but saw none`,
    counts.received === 0 &&
      `${kusamaBridgeHub}: expected at least one ${inboundMessages}.MessagesReceived event but saw none — receive_messages_proof did not dispatch`,
    counts.bridgeHubFailures > 0 &&
      `${kusamaBridgeHub}: ${counts.bridgeHubFailures} ExtrinsicFailed event(s) — likely the receive_messages_proof call failed`,
    counts.processedSuccess === 0 &&
      `${kusamaAssetHub}: expected at least one MessageQueue.Processed{success:true} event but saw none`,
    counts.processedFailure > 0 &&
      `${kusamaAssetHub}: ${counts.processedFailure} MessageQueue.Processed{success:false} event(s) — XCM execution failed`,
  ].filter((failure): failure is string => typeof failure === 'string');

  const summary = [
    `  ${polkadotBridgeHub}:`,
    `    ${outboundMessages}.MessageAccepted = ${counts.accepted}`,
    `  ${kusamaBridgeHub}:`,
    `    ${inboundMessages}.MessagesReceived = ${counts.received}`,
    `    XcmpQueue.XcmpMessageSent = ${counts.forwarded}`,
    `    System.ExtrinsicFailed = ${counts.bridgeHubFailures}`,
    `  ${kusamaAssetHub}:`,
    `    MessageQueue.Processed{success:true} = ${counts.processedSuccess}`,
    `    MessageQueue.Processed{success:false} = ${counts.processedFailure}`,
    `    Whitelist.CallWhitelisted = ${counts.whitelisted}`,
  ];
  if (failures.length === 0) {
    logger.success('Bridge delivery verified — all happy-path markers fired:');
    for (const line of summary) logger.info(line);
  } else {
    logger.error('Bridge delivery did NOT pass verification:');
    for (const line of summary) logger.info(line);
    logger.error('Failure reasons:');
    for (const failure of failures) logger.error(`  - ${failure}`);
  }
  if (counts.whitelisted === 0) {
    logger.warn(
      `No Whitelist.CallWhitelisted event on ${kusamaAssetHub}: the XCM executed, but its Transact either failed or carried a different call`
    );
  }
  return failures;
}
