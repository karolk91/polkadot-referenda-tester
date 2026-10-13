import { type BridgeHandle, connectBridgeHubs } from '@acala-network/chopsticks-testing';
import { toHex } from '@polkadot-api/utils';
import type { Fork } from '../network/fork';
import { aliceKeyPair } from '../utils/alice';
import {
  type BridgePayloadCodec,
  buildBridgePayloadCodec,
  type DecodedBridgeMessage,
} from '../utils/bridge-payload';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import type { ForkEventLog } from './fork-event-log';

export const DEFAULT_MAX_PUMP_ROUNDS = 8;

export const POLKADOT_TO_KUSAMA_PALLETS = {
  outboundMessages: 'BridgeKusamaMessages',
  inboundMessages: 'BridgePolkadotMessages',
} as const;

const QUIET_ROUND_LIMIT = 2;
const RELAYER_REACTION_DELAY_MS = 500;

export interface BridgePolkadotSide {
  collectives: Fork;
  assetHub: Fork;
  bridgeHub: Fork;
  additional: Fork[];
}

export interface BridgeKusamaSide {
  assetHub: Fork;
  bridgeHub: Fork;
  additional: Fork[];
}

export interface PumpReport {
  messageCount: number;
  laneCount: number;
  rounds: number;
}

type OutboundMessage = { lane: string; nonce: bigint; payload: Uint8Array } & (
  | { decoded: DecodedBridgeMessage }
  | { decodeError: string }
);

interface OutboundMessagesPallet {
  OutboundLanes: {
    getEntries(): Promise<
      Array<{
        keyArgs: [string];
        value: { latest_generated_nonce: bigint; latest_received_nonce: bigint };
      }>
    >;
  };
  OutboundMessages: {
    getValue(key: { lane_id: string; nonce: bigint }): Promise<Uint8Array | undefined>;
  };
}

export async function connectBridgeRelayer(
  polkadot: BridgePolkadotSide,
  kusama: BridgeKusamaSide,
  logger: Logger
): Promise<BridgeHandle> {
  const alice = aliceKeyPair();
  logger.startSpinner('Connecting bridge relayer (Polkadot → Kusama)...');
  const handle = await connectBridgeHubs(
    polkadot.bridgeHub.manager.context.api,
    kusama.bridgeHub.manager.context.api,
    { signer: alice }
  );
  logger.succeedSpinner(`Bridge relayer connected (signer=${alice.address})`);
  return handle;
}

export class BridgePump {
  private readonly lastSeenNonceByLane = new Map<string, bigint>();

  private constructor(
    private readonly logger: Logger,
    private readonly polkadot: BridgePolkadotSide,
    private readonly kusama: BridgeKusamaSide,
    private readonly codec: BridgePayloadCodec,
    private readonly maxRounds: number
  ) {}

  static async create(
    logger: Logger,
    polkadot: BridgePolkadotSide,
    kusama: BridgeKusamaSide,
    maxRounds: number
  ): Promise<BridgePump> {
    logger.startSpinner('Loading Bridge Hub metadata for payload codec...');
    const metadata = await polkadot.bridgeHub.client._request<string, []>('state_getMetadata', []);
    const codec = buildBridgePayloadCodec(metadata);
    logger.succeedSpinner(
      `Bridge payload codec loaded from ${polkadot.bridgeHub.info.label} metadata`
    );
    return new BridgePump(logger, polkadot, kusama, codec, maxRounds);
  }

  async pumpUntilQuiet(log: ForkEventLog): Promise<PumpReport> {
    const lanes = new Set<string>();
    let messageCount = 0;
    let quietRounds = 0;
    let rounds = 0;
    while (rounds < this.maxRounds && quietRounds < QUIET_ROUND_LIMIT) {
      rounds++;
      this.logger.debug(
        `Bridge pump round ${rounds}/${this.maxRounds} (quiet streak ${quietRounds})`
      );
      for (const fork of [
        this.polkadot.collectives,
        this.polkadot.assetHub,
        this.polkadot.bridgeHub,
        ...this.polkadot.additional,
      ]) {
        await log.advance(fork);
      }
      await new Promise((resolve) => setTimeout(resolve, RELAYER_REACTION_DELAY_MS));
      for (const fork of [this.kusama.bridgeHub, this.kusama.assetHub, ...this.kusama.additional]) {
        await log.advance(fork);
      }

      const messages = await this.newOutboundMessages().catch((error: Error) => {
        this.logger.warn(`Failed to read outbound bridge messages: ${error.message}`);
        return [];
      });
      quietRounds = messages.length === 0 ? quietRounds + 1 : 0;
      messageCount += messages.length;
      for (const message of messages) {
        lanes.add(message.lane);
        this.logMessage(message);
      }
    }
    return { messageCount, laneCount: lanes.size, rounds };
  }

  private async newOutboundMessages(): Promise<OutboundMessage[]> {
    const pallet = (this.polkadot.bridgeHub.api.query as unknown as Record<string, unknown>)[
      POLKADOT_TO_KUSAMA_PALLETS.outboundMessages
    ] as OutboundMessagesPallet | undefined;
    if (!pallet) return [];

    const messages: OutboundMessage[] = [];
    for (const { keyArgs, value } of await pallet.OutboundLanes.getEntries()) {
      const [lane] = keyArgs;
      const firstUnseen =
        (this.lastSeenNonceByLane.get(lane) ?? BigInt(value.latest_received_nonce)) + 1n;
      for (let nonce = firstUnseen; nonce <= BigInt(value.latest_generated_nonce); nonce++) {
        const payload = await pallet.OutboundMessages.getValue({ lane_id: lane, nonce });
        this.lastSeenNonceByLane.set(lane, nonce);
        if (payload) {
          messages.push(this.decodedMessage(lane, nonce, payload));
        }
      }
    }
    return messages;
  }

  private decodedMessage(lane: string, nonce: bigint, payload: Uint8Array): OutboundMessage {
    try {
      return { lane, nonce, payload, decoded: this.codec.decode(payload) };
    } catch (error) {
      return { lane, nonce, payload, decodeError: (error as Error).message };
    }
  }

  private logMessage(message: OutboundMessage): void {
    this.logger.info(
      `\u{1F309} ${this.polkadot.bridgeHub.info.label}: bridge message ${message.lane} #${message.nonce} (${message.payload.length} bytes)`
    );
    if ('decoded' in message) {
      this.logger.info(`   universalDest = ${stringify(message.decoded.universalDest)}`);
      this.logger.debug(`   message = ${stringify(message.decoded.message, 2)}`);
    } else {
      this.logger.warn(`   decode failed: ${message.decodeError}`);
      this.logger.debug(`   raw payload: ${toHex(message.payload)}`);
    }
  }
}
