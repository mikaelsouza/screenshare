import type { PeerId } from "@shared/protocol";
import type { TileController } from "../controllers/tile-controller";
import type { Mesh } from "../mesh";
import { LinkMonitor, summarize } from "../stats";
import type { TileView } from "./tile-view";

export interface HealthPollerContext {
  getMesh: () => Mesh | null;
  isSharing: () => boolean;
  getMemberIds: () => Iterable<PeerId>;
  tileCtrl: TileController;
  tileView: TileView;
  onOutboundUpdated: () => void;
  runBackground: (task: Promise<unknown>) => void;
}

export class HealthPoller {
  private readonly ctx: HealthPollerContext;
  private readonly inbound = new Map<PeerId, LinkMonitor>();
  private readonly outbound = new Map<PeerId, LinkMonitor>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: HealthPollerContext) {
    this.ctx = ctx;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), 2_000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  deleteInbound(peerId: PeerId): void {
    this.inbound.delete(peerId);
  }

  deleteOutbound(peerId: PeerId): void {
    this.outbound.delete(peerId);
  }

  clearOutbound(): void {
    this.outbound.clear();
  }

  clearAll(): void {
    this.inbound.clear();
    this.outbound.clear();
  }

  private tick(): void {
    const activeMesh = this.ctx.getMesh();
    if (!activeMesh) return;
    this.pollInbound(activeMesh);
    if (this.ctx.isSharing()) {
      this.pollOutbound(activeMesh);
    } else {
      this.ctx.tileCtrl.clearOutboundStats();
    }
  }

  private pollInbound(activeMesh: Mesh): void {
    for (const peerId of activeMesh.peers()) {
      const pc = activeMesh.getConnection(peerId);
      const target = this.ctx.tileView.getHealthEl(peerId);
      if (!pc || !target) continue;
      if (this.ctx.tileCtrl.isPaused(peerId)) {
        target.textContent = "paused";
        continue;
      }
      let monitor = this.inbound.get(peerId);
      if (!monitor) {
        monitor = new LinkMonitor(pc, "inbound");
        this.inbound.set(peerId, monitor);
      }
      this.ctx.runBackground(
        monitor.read().then((health) => {
          if (!health || this.ctx.tileCtrl.isPaused(peerId)) return;
          target.textContent = summarize(health, true);
        }),
      );
    }
  }

  private pollOutbound(activeMesh: Mesh): void {
    const peerIds = [...new Set([...this.ctx.getMemberIds(), ...activeMesh.peers()])];
    this.ctx.runBackground(
      Promise.all(peerIds.map((peerId) => this.readPeerOutbound(activeMesh, peerId))).then((results) => {
        if (!this.ctx.isSharing()) return;
        const activeViewers = results.filter((res) => res.viewing).length;
        const sumBps = results.reduce((acc, res) => acc + res.bps, 0);
        this.ctx.tileCtrl.setOutboundSummary(activeViewers, sumBps / 1e6);
        this.ctx.onOutboundUpdated();
      }),
    );
  }

  private async readPeerOutbound(activeMesh: Mesh, peerId: PeerId): Promise<{ viewing: boolean; bps: number }> {
    const pc = activeMesh.getConnection(peerId);
    if (!pc) {
      this.ctx.tileCtrl.setPeerOutboundText(peerId, null);
      return { viewing: false, bps: 0 };
    }
    if (!activeMesh.isPeerViewing(peerId)) {
      this.ctx.tileCtrl.setPeerOutboundText(peerId, "↑ paused");
      return { viewing: false, bps: 0 };
    }
    let outMon = this.outbound.get(peerId);
    if (!outMon) {
      outMon = new LinkMonitor(pc, "outbound");
      this.outbound.set(peerId, outMon);
    }
    const health = await outMon.read();
    if (!health) {
      this.ctx.tileCtrl.setPeerOutboundText(peerId, "↑ connecting…");
      return { viewing: true, bps: 0 };
    }
    this.ctx.tileCtrl.setPeerOutboundText(peerId, `↑ ${summarize(health, false)}`);
    return { viewing: true, bps: health.bitrate ?? 0 };
  }
}
