// Replace: import WebSocket from "isomorphic-ws";
import WebSocket from "ws";

type JsonRpcId = number | string;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any[];
}
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: { subscription: JsonRpcId; result: any };
}
interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: any;
}
interface JsonRpcError {
  jsonrpc: "2.0";
  id: number;
  error: any;
}
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError | JsonRpcNotification;

export class WsProvider {
  private ws?: WebSocket;
  private id = 0;
  private pending = new Map<number, (data: any) => void>();
  private subs = new Map<string, (data: any) => void>();
  private reconnect = true;
  private backoff = 250;

  constructor(private endpoint: string) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === this.ws.OPEN) return;
    await new Promise<void>((resolve) => {
      this.ws = new WebSocket(this.endpoint);
      this.ws.onopen = () => {
        this.backoff = 250;
        resolve();
      };
      this.ws.onmessage = (e) => this.onMessage(e);
      this.ws.onclose = () => this.onClose();
      this.ws.onerror = () => {};
    });
  }

  private onClose() {
    if (!this.reconnect) return;
    setTimeout(() => this.connect().catch(() => {}), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  private onMessage(evt: WebSocket.MessageEvent) {
    const data = (evt as any).data?.toString?.() ?? (evt as any).data;
    const msg = JSON.parse(String(data)) as JsonRpcResponse;

    if (
      "method" in msg &&
      msg.method &&
      "params" in msg &&
      (msg as any).params?.subscription != null
    ) {
      const subId = String((msg as any).params.subscription);
      this.subs.get(subId)?.((msg as any).params.result);
      return;
    }
    if ("id" in msg && this.pending.has(msg.id as number)) {
      const resolve = this.pending.get(msg.id as number)!;
      this.pending.delete(msg.id as number);
      if ("error" in msg && msg.error)
        throw new Error(JSON.stringify(msg.error));
      resolve((msg as JsonRpcSuccess).result);
    }
  }

  async send(method: string, params: any[] = []) {
    await this.connect();
    const id = ++this.id;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.ws!.send(JSON.stringify(payload));
    return await new Promise<any>((resolve) => this.pending.set(id, resolve));
  }

  async subscribe(
    method: string,
    unsubscribeMethod: string,
    params: any[],
    cb: (data: any) => void,
  ) {
    const subId = await this.send(method, params);
    this.subs.set(String(subId), cb);
    return async () => {
      try {
        await this.send(unsubscribeMethod, [subId]);
      } finally {
        this.subs.delete(String(subId));
      }
    };
  }
}
