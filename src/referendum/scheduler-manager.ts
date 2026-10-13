import { toHex } from '@polkadot-api/utils';
import type { HexString } from 'polkadot-api';
import { blockNumber } from '../network/chain-client';
import type { ChopsticksManager } from '../network/chopsticks-manager';
import type { TaskAddress } from '../types';
import type { ScheduledCall, ScheduledEntry, SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';
import { toPolkadotJsJson } from '../utils/storage-format-converter';
import type { ReferendaKind } from './referenda-kind';

const ROOT_ORIGIN = { system: 'Root' };

async function agendaTaskAddress(
  api: SubstrateApi,
  isMatch: (task: ScheduledEntry) => boolean | Promise<boolean>
): Promise<TaskAddress | undefined> {
  for (const { keyArgs, value } of await api.query.Scheduler.Agenda.getEntries()) {
    for (const [index, task] of value.entries()) {
      if (task && (await isMatch(task))) return { block: Number(keyArgs[0]), index };
    }
  }
  return undefined;
}

export async function scheduledTaskAddress(
  api: SubstrateApi,
  name: HexString,
  logger: Logger
): Promise<TaskAddress | undefined> {
  let address: [number, number] | undefined;
  try {
    address = await api.query.Scheduler.Lookup.getValue(name);
  } catch (error) {
    logger.debug(
      `Scheduler.Lookup is unreadable (${(error as Error).message}); scanning Scheduler.Agenda for task ${name}`
    );
    return agendaTaskAddress(api, (task) => task.maybe_id === name);
  }
  return address && { block: address[0], index: address[1] };
}

export class SchedulerManager {
  constructor(
    private readonly logger: Logger,
    private readonly chopsticks: ChopsticksManager,
    private readonly api: SubstrateApi
  ) {}

  async nextAgendaBlock(): Promise<number> {
    const incompleteSince = await this.api.query.Scheduler.IncompleteSince.getValue();
    return incompleteSince ?? (await blockNumber(this.api)) + 1;
  }

  async moveTask(source: TaskAddress, targetBlock: number): Promise<TaskAddress> {
    if (source.block === targetBlock) return source;
    const sourceAgenda = await this.agenda(source.block);
    const task = sourceAgenda[source.index];
    if (!task) {
      throw new Error(`No scheduled task at [${source.block}, ${source.index}]`);
    }
    const targetAgenda = await this.agenda(targetBlock);
    const target = { block: targetBlock, index: targetAgenda.length };
    this.logger.info(
      `Moving scheduled task [${source.block}, ${source.index}] to [${target.block}, ${target.index}]`
    );
    await this.chopsticks.setStorageBatch({
      Scheduler: {
        Agenda: [
          [[source.block], toPolkadotJsJson(sourceAgenda.with(source.index, undefined))],
          [[targetBlock], toPolkadotJsJson([...targetAgenda, task])],
        ],
        ...(task.maybe_id && { Lookup: [[[task.maybe_id], [target.block, target.index]]] }),
      },
    });
    return target;
  }

  async appendInlineCall(callHex: HexString, origin: unknown, block: number): Promise<TaskAddress> {
    const agenda = await this.agenda(block);
    await this.chopsticks.setStorageBatch({
      Scheduler: {
        Agenda: [
          [
            [block],
            [...(toPolkadotJsJson(agenda) as unknown[]), { call: { Inline: callHex }, origin }],
          ],
        ],
      },
    });
    return { block, index: agenda.length };
  }

  async scheduleNudge(
    kind: ReferendaKind,
    referendumId: number,
    block: number
  ): Promise<TaskAddress> {
    const alarm = await agendaTaskAddress(this.api, (task) =>
      this.isNudgeCall(task.call, kind, referendumId)
    );
    if (alarm) return this.moveTask(alarm, block);

    this.logger.info(
      `No scheduled nudge found for referendum ${referendumId} (likely queued for a deciding slot) - injecting one`
    );
    const callData = await this.api.tx[kind.palletName]
      .nudge_referendum({ index: referendumId })
      .getEncodedData();
    return this.appendInlineCall(toHex(callData) as HexString, ROOT_ORIGIN, block);
  }

  private async isNudgeCall(
    call: ScheduledCall,
    kind: ReferendaKind,
    referendumId: number
  ): Promise<boolean> {
    if (call.type !== 'Inline') return false;
    try {
      const { decodedCall } = await this.api.txFromCallData(call.value);
      return (
        decodedCall.type === kind.palletName &&
        decodedCall.value.type === 'nudge_referendum' &&
        Number(decodedCall.value.value?.index) === referendumId
      );
    } catch (error) {
      this.logger.debug(`Failed to decode inline call: ${error}`);
      return false;
    }
  }

  private async agenda(block: number): Promise<Array<ScheduledEntry | undefined>> {
    return (await this.api.query.Scheduler.Agenda.getValue(block)) ?? [];
  }
}
