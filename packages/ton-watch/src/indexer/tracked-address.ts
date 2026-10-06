import type { AddressState, TxId } from "../core/types";

/** An address's on-chain last transaction as of a chain tip. */
export interface ChainObservation {
  lastTx: TxId | null;
  syncLt: bigint;
  utime: number;
}

/** The indexer's in-memory view of one address. */
export interface TrackedAddress {
  /** Last state read from the store, updated in place as the indexer advances it. */
  state: AddressState;
  /** Unset until the address's last transaction has been read once. */
  observed?: ChainObservation;
  /** Poll mode: earliest time (ms) of the next poll. */
  nextPollAt: number;
  /** Poll mode: polls in a row that found no change. */
  idleStreak: number;
  /** Last time (ms) the on-chain last tx was read directly (not via block listing). */
  verifiedAt: number;
  /**
   * Set while a reconciliation poll is in flight: what block listing believed the
   * last transaction was. `undefined` when not reconciling.
   */
  reconcilingFrom?: TxId | null;
  /** Frontier and gaps need rechecking at the next maintenance round. */
  needsMaintenance: boolean;
  gapsOpen: number;
}

/** The active addresses, mirrored from the store each tick. */
export class AddressTable {
  private readonly byAddress = new Map<string, TrackedAddress>();

  get size(): number {
    return this.byAddress.size;
  }

  get(address: string): TrackedAddress | undefined {
    return this.byAddress.get(address);
  }

  all(): TrackedAddress[] {
    return [...this.byAddress.values()];
  }

  addresses(): string[] {
    return [...this.byAddress.keys()];
  }

  /** Whether any address still lacks a first observation. */
  anyUnobserved(): boolean {
    return this.all().some((tracked) => !tracked.observed);
  }

  /**
   * Updates states, starts tracking new addresses and drops ones no longer in
   * `states`. Returns the dropped addresses.
   */
  sync(states: AddressState[]): string[] {
    const current = new Set<string>();
    for (const state of states) {
      current.add(state.address);
      const tracked = this.byAddress.get(state.address);
      if (tracked) tracked.state = state;
      else this.byAddress.set(state.address, newTrackedAddress(state));
    }
    const dropped = this.addresses().filter((address) => !current.has(address));
    for (const address of dropped) this.byAddress.delete(address);
    return dropped;
  }
}

function newTrackedAddress(state: AddressState): TrackedAddress {
  return {
    state,
    nextPollAt: 0,
    idleStreak: 0,
    verifiedAt: 0,
    needsMaintenance: true,
    gapsOpen: 0,
  };
}
