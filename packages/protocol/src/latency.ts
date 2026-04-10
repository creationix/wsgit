import type { WebSocket, RawData } from "ws";

export interface LatencyConfig {
  /** Base latency in milliseconds applied to each direction (half of simulated RTT). */
  latencyMs: number;
  /** Random jitter ±ms added to each delay. */
  jitterMs?: number;
}

function delay(config: LatencyConfig): Promise<void> {
  let ms = config.latencyMs;
  if (config.jitterMs) {
    ms += (Math.random() * 2 - 1) * config.jitterMs;
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a WebSocket with latency injection.
 * Returns a proxy with the same interface but delayed send/receive.
 */
export function wrapWithLatency(
  ws: WebSocket,
  config: LatencyConfig,
): WebSocket {
  if (config.latencyMs <= 0 && (!config.jitterMs || config.jitterMs <= 0)) {
    return ws;
  }

  const originalSend = ws.send.bind(ws);
  ws.send = ((...args: Parameters<WebSocket["send"]>) => {
    delay(config).then(() => originalSend(...args));
  }) as WebSocket["send"];

  const originalOn = ws.on.bind(ws);
  ws.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "message") {
      return originalOn(event, (data: RawData, isBinary: boolean) => {
        delay(config).then(() => listener(data, isBinary));
      });
    }
    return originalOn(event, listener);
  }) as WebSocket["on"];

  return ws;
}
