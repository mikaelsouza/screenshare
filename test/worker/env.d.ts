import type { RoomDO } from "../../worker/room";

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<RoomDO>;
    }
  }
}
