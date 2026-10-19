import type { Fork } from '../network/fork';
import { blockEvents, type ParsedEvent } from '../utils/events';

export class ForkEventLog {
  private readonly eventsByFork = new Map<Fork, ParsedEvent[]>();

  async advance(fork: Fork): Promise<void> {
    await fork.manager.newBlock();
    this.eventsByFork.set(fork, [...this.events(fork), ...(await blockEvents(fork.api))]);
  }

  events(fork: Fork): ParsedEvent[] {
    return this.eventsByFork.get(fork) ?? [];
  }
}
