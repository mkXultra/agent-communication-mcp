// Test harness: an HTTP / WebSocket pass-through proxy in front of the real agora.
// It never answers API requests itself; it only changes the network conditions around them:
// - refuse, drop or leave WebSocket upgrades unanswered (an environment where WebSockets cannot be established)
// - drop, delay or hold responses (a lost response, a slow server, a hanging connection)
// - black-hole the WebSocket connections that are open, without closing them (a NAT that forgot the mapping)
// - add agora's test-only headers (x-agora-fault / x-agora-test-vars, effective with FAULT_INJECTION=1)
// - record requests and the client -> server WebSocket frames (with the time each arrived)
// - cut proxied WebSocket connections

import http from 'http';
import net from 'net';

export interface RecordedRequest {
  method: string;
  path: string;
}

export type WebSocketPolicy = 'pass' | 'reject' | 'destroy' | 'hang';

type RequestPredicate = (request: RecordedRequest) => boolean;

interface Tunnel {
  client: net.Socket;
  upstream: net.Socket;
  /** Bytes are dropped in both directions while set; the sockets stay open. */
  frozen: boolean;
}

export class AgoraProxy {
  readonly requests: RecordedRequest[] = [];
  /** Text frames sent by clients over proxied WebSockets, parsed as JSON. */
  readonly clientFrames: Array<Record<string, unknown>> = [];
  /** The same frames with the time (ms since the epoch) the proxy received each. */
  readonly clientFrameLog: Array<{ at: number; frame: Record<string, unknown> }> = [];
  webSocketPolicy: WebSocketPolicy = 'pass';
  /** Extra headers added to every forwarded request, WebSocket upgrades included. */
  extraHeaders: Record<string, string> = {};
  /** Extra headers for the requests the function returns them for (added after `extraHeaders`). */
  headersFor: (request: RecordedRequest) => Record<string, string> | undefined = () => undefined;

  private dropNext: RequestPredicate | undefined;
  private delays: Array<{ match: RequestPredicate; ms: number }> = [];
  private hold: RequestPredicate | undefined;
  private readonly tunnels = new Set<Tunnel>();
  private readonly heldSockets = new Set<net.Socket>();

  private constructor(
    private readonly server: http.Server,
    private readonly target: URL,
    readonly url: string,
  ) {}

  static async start(targetUrl: string): Promise<AgoraProxy> {
    const target = new URL(targetUrl);
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const proxy = new AgoraProxy(server, target, `http://127.0.0.1:${address.port}`);
    server.on('request', (req, res) => proxy.forward(req, res));
    server.on('upgrade', (req, socket, head) => proxy.tunnel(req, socket as net.Socket, head));
    return proxy;
  }

  /** Back to a plain pass-through: rules, headers and recordings are cleared (open tunnels are kept). */
  reset(): void {
    this.requests.length = 0;
    this.clientFrames.length = 0;
    this.clientFrameLog.length = 0;
    this.webSocketPolicy = 'pass';
    this.extraHeaders = {};
    this.headersFor = () => undefined;
    this.dropNext = undefined;
    this.delays = [];
    this.hold = undefined;
    this.releaseFrozenWebSockets();
    for (const socket of this.heldSockets) socket.destroy();
    this.heldSockets.clear();
  }

  /** The next request matching `predicate` reaches agora, but its response never reaches the client. */
  dropResponseOnce(predicate: RequestPredicate): void {
    this.dropNext = predicate;
  }

  /** Responses to matching requests reach the client `ms` later (agora has already processed the request). */
  delayResponses(predicate: RequestPredicate, ms: number): void {
    this.delays.push({ match: predicate, ms });
  }

  /** Matching requests are neither forwarded nor answered while the rule is set (`undefined` clears it). */
  holdRequests(predicate: RequestPredicate | undefined): void {
    this.hold = predicate;
  }

  /**
   * The WebSocket connections open right now go silent: their bytes are dropped in both directions, but neither
   * side sees a close. Connections made afterwards pass normally.
   */
  freezeWebSockets(): void {
    for (const tunnel of this.tunnels) tunnel.frozen = true;
  }

  /** Cuts the frozen connections (as a NAT that finally resets them would). */
  releaseFrozenWebSockets(): void {
    for (const tunnel of [...this.tunnels]) {
      if (tunnel.frozen) this.destroyTunnel(tunnel);
    }
  }

  /** Cuts every proxied WebSocket (as a network failure would). */
  destroyWebSockets(): void {
    for (const tunnel of [...this.tunnels]) this.destroyTunnel(tunnel);
  }

  countRequests(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }

  async close(): Promise<void> {
    this.destroyWebSockets();
    for (const socket of this.heldSockets) socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private headersForRequest(record: RecordedRequest): Record<string, string> {
    return { ...this.extraHeaders, ...(this.headersFor(record) ?? {}) };
  }

  private destroyTunnel(tunnel: Tunnel): void {
    this.tunnels.delete(tunnel);
    tunnel.client.destroy();
    tunnel.upstream.destroy();
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const record = { method: req.method ?? 'GET', path: req.url ?? '/' };
    this.requests.push(record);
    if (this.hold?.(record)) {
      // Leave the client waiting; the socket is destroyed by reset() or when the proxy closes.
      this.heldSockets.add(req.socket);
      req.socket.once('close', () => this.heldSockets.delete(req.socket));
      req.resume();
      return;
    }
    const drop = this.dropNext?.(record) ?? false;
    if (drop) this.dropNext = undefined;
    const delay = this.delays.find((rule) => rule.match(record))?.ms ?? 0;

    const upstream = http.request(
      {
        host: this.target.hostname,
        port: this.target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: this.target.host, ...this.headersForRequest(record) },
      },
      (upstreamRes) => {
        if (drop) {
          upstreamRes.resume();
          upstreamRes.on('end', () => req.socket.destroy());
          return;
        }
        const respond = (): void => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        };
        if (delay > 0) {
          upstreamRes.pause();
          setTimeout(respond, delay);
        } else {
          respond();
        }
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  }

  private tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const record = { method: 'UPGRADE', path: req.url ?? '/' };
    this.requests.push(record);
    if (this.webSocketPolicy === 'reject') {
      client.end('HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: 21\r\nconnection: close\r\n\r\nWebSocket not allowed');
      return;
    }
    if (this.webSocketPolicy === 'destroy') {
      client.destroy();
      return;
    }
    if (this.webSocketPolicy === 'hang') {
      this.heldSockets.add(client);
      client.once('close', () => this.heldSockets.delete(client));
      client.on('error', () => undefined);
      return;
    }

    const upstream = net.connect(Number(this.target.port), this.target.hostname);
    const tunnel: Tunnel = { client, upstream, frozen: false };
    this.tunnels.add(tunnel);

    let pending = Buffer.alloc(0);
    const fromClient = (chunk: Buffer): void => {
      if (tunnel.frozen) return;
      upstream.write(chunk);
      pending = this.readClientFrames(Buffer.concat([pending, chunk]));
    };
    upstream.once('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? this.target.host : req.rawHeaders[i + 1]}`);
      }
      for (const [name, value] of Object.entries(this.headersForRequest(record))) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) fromClient(head);
      upstream.on('data', (chunk: Buffer) => {
        if (!tunnel.frozen) client.write(chunk);
      });
      // Client bytes that arrived before the upstream connection stay buffered in the paused socket until now.
      client.on('data', fromClient);
    });
    const cleanup = (): void => this.destroyTunnel(tunnel);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    client.on('error', cleanup);
    upstream.on('error', cleanup);
  }

  /** Decodes complete masked client frames (RFC 6455 §5.2) and returns the unconsumed bytes. */
  private readClientFrames(buffer: Buffer): Buffer {
    let offset = 0;
    for (;;) {
      if (buffer.length - offset < 2) break;
      const opcode = buffer[offset]! & 0x0f;
      const masked = (buffer[offset + 1]! & 0x80) !== 0;
      let length = buffer[offset + 1]! & 0x7f;
      let cursor = offset + 2;
      if (length === 126) {
        if (buffer.length - cursor < 2) break;
        length = buffer.readUInt16BE(cursor);
        cursor += 2;
      } else if (length === 127) {
        if (buffer.length - cursor < 8) break;
        length = Number(buffer.readBigUInt64BE(cursor));
        cursor += 8;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length - cursor < maskLength + length) break;
      const mask = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
      cursor += maskLength;
      const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      if (opcode === 0x1) {
        try {
          const frame = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
          this.clientFrames.push(frame);
          this.clientFrameLog.push({ at: Date.now(), frame });
        } catch {
          // Not JSON; not interesting here.
        }
      }
      offset = cursor + length;
    }
    return buffer.subarray(offset);
  }
}
