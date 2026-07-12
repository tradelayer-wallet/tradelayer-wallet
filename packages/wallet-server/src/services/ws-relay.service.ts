import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import { URL } from 'url';

const WS = require('ws');

type WsRelayRequest = {
  id?: string;
  method?: string;
  path?: string;
  query?: Record<string, any>;
  body?: any;
  headers?: Record<string, string>;
};

type WsRelaySessionStats = {
  sessionId: string;
  boundPath: string;
  connectedAt: string;
  active: boolean;
  authenticated: boolean;
  origin?: string;
  receivedPackets: number;
  repliedPackets: number;
  failedPackets: number;
  lastReceivedAt?: string;
  lastRepliedAt?: string;
  lastMethod?: string;
  lastTargetPath?: string;
  lastError?: string;
};

type RelaySecurityConfig = {
  authenticationRequired: boolean;
  token: string;
  allowedOrigins: string[];
};

type RelayRouteRule = {
  method: 'GET' | 'POST';
  matches: (path: string) => boolean;
};

const RELAY_TOKEN_QUERY_KEY = 'tl_relay_token';
const RELAY_TOKEN_HEADER = 'x-tradelayer-relay-token';
const RELAY_ALLOWED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'x-request-id']);
const RELAY_FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-tradelayer-internal-relay',
  'x-tradelayer-local-auth',
  RELAY_TOKEN_HEADER,
]);

const RELAY_PUBLIC_RPC_METHODS = new Set([
  'getblockchaininfo',
  'getblockhash',
  'getblockheader',
  'getnetworkinfo',
  'getrawtransaction',
  'decoderawtransaction',
  'decodescript',
  'estimatefee',
  'validateaddress',
  'tl_getstatesnapshot',
  'tl_getsyncstatus',
  'tl_getallbalancesforaddress',
  'tl_getchannel',
  'tl_getchannelcolumn',
  'tl_getcontractinfo',
  'tl_getattestations',
  'tl_gettransaction',
  'tl_getclearlistbyid',
  'tl_listcontractseries',
  'tl_getinitmargin',
  'tl_channelbalanceforcommiter',
  'tl_getmaxsynth',
  'tl_contractposition',
  'tl_tokentradehistoryforaddress',
  'tl_contracttradehistoryforaddress',
  'tl_totaltradehistoryforaddress',
  'tl_getinfo',
  'tl_getbalance',
  'tl_getproperty',
  'tl_listproperties',
  'tl_createpayload_attestation',
  'tl_createpayload_commit_tochannel',
  'tl_createpayload_withdrawal_fromchannel',
  'tl_createpayload_simplesend',
  'tl_createpayload_instant_ltc_trade',
  'tl_createpayload_instant_trade',
  'tl_createpayload_contract_instant_trade',
  'tl_createpayload_sendactivation',
]);

const RELAY_ROUTE_RULES: RelayRouteRule[] = [
  { method: 'GET', matches: (path) => path === '/api/tradelayer/sync-status' },
  { method: 'GET', matches: (path) => path === '/api/tradelayer/collator-status' },
  {
    method: 'POST',
    matches: (path) => {
      const rpcMatch = /^\/rpc\/([a-z0-9_]+)$/i.exec(path);
      return !!rpcMatch && RELAY_PUBLIC_RPC_METHODS.has(rpcMatch[1].toLowerCase());
    },
  },
];

const jsonReply = (ws: any, payload: Record<string, unknown>) => {
  ws.send(JSON.stringify(payload));
};

function isTruthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeOrigins(value: unknown) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(`Invalid TL_WS_RELAY_ALLOWED_ORIGINS entry: ${origin}`);
      }
    });
}

export function getRelaySecurityConfig(env: NodeJS.ProcessEnv = process.env): RelaySecurityConfig {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const developmentOptOut = !production && isTruthy(env.TL_WS_RELAY_ALLOW_INSECURE_DEV);
  const token = String(env.TL_WS_RELAY_TOKEN || env.TL_WS_RELAY_SECRET || '').trim();

  if (production && !token) {
    throw new Error('TL_WS_RELAY_TOKEN is required when NODE_ENV=production');
  }
  if (!production && !token && !developmentOptOut) {
    throw new Error('Set TL_WS_RELAY_TOKEN or explicitly set TL_WS_RELAY_ALLOW_INSECURE_DEV=1 outside production');
  }

  return {
    authenticationRequired: !developmentOptOut,
    token,
    allowedOrigins: normalizeOrigins(env.TL_WS_RELAY_ALLOWED_ORIGINS),
  };
}

export function isRelayRouteAllowed(method: string, path: string) {
  return RELAY_ROUTE_RULES.some((rule) => rule.method === method && rule.matches(path));
}

function normalizeRelayPath(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[?#]/.test(raw)) {
    return null;
  }
  if (/%2f|%5c/i.test(raw)) {
    return null;
  }
  try {
    const parsed = new URL(raw, 'http://relay.invalid');
    return parsed.pathname === raw ? raw : null;
  } catch {
    return null;
  }
}

function isPlainJsonValue(value: any): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).every((key) => !['__proto__', 'constructor', 'prototype'].includes(key) && isPlainJsonValue(value[key]));
}

function hasQuery(query: unknown) {
  return !!query && typeof query === 'object' && Object.keys(query as Record<string, unknown>).length > 0;
}

function sanitizeRelayHeaders(headers: unknown): Record<string, string> | null {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;

  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers as Record<string, unknown>)) {
    const name = rawName.toLowerCase();
    if (RELAY_FORBIDDEN_REQUEST_HEADERS.has(name) || !RELAY_ALLOWED_REQUEST_HEADERS.has(name) || typeof rawValue !== 'string') {
      return null;
    }
    sanitized[name] = rawValue;
  }
  return sanitized;
}

function tokenMatches(expected: string, provided: string) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function relayTokenFromRequest(req: IncomingMessage, url: URL) {
  const authorization = String(req.headers.authorization || '').trim();
  const bearerToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  return String(
    req.headers[RELAY_TOKEN_HEADER]
    || bearerToken
    || url.searchParams.get(RELAY_TOKEN_QUERY_KEY)
    || ''
  ).trim();
}

export function isRelayOriginAllowed(origin: string | undefined, host: string | undefined, allowedOrigins: string[]) {
  if (!origin) return true;
  try {
    const normalizedOrigin = new URL(origin).origin;
    if (normalizedOrigin === 'null') return false;
    if (allowedOrigins.length) return allowedOrigins.includes(normalizedOrigin);
    const normalizedHost = host ? new URL(`http://${host}`).host.toLowerCase() : '';
    return !!normalizedHost && new URL(normalizedOrigin).host.toLowerCase() === normalizedHost;
  } catch {
    return false;
  }
}

function relayValidationError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateRelayRequest(payload: WsRelayRequest, boundPath: string) {
  const method = (payload.method || (payload.body ? 'POST' : 'GET')).toUpperCase();
  const targetPath = normalizeRelayPath(payload.path || boundPath);
  const headers = sanitizeRelayHeaders(payload.headers);
  if (!targetPath || !['GET', 'POST'].includes(method) || !isRelayRouteAllowed(method, targetPath)) {
    throw relayValidationError('Relay route or method is not allowed', 403);
  }
  if (hasQuery(payload.query)) {
    throw relayValidationError('Relay query parameters are not allowed', 400);
  }
  if ((method === 'GET' && payload.body !== undefined) || (method === 'POST' && !isPlainJsonValue(payload.body ?? {}))) {
    throw relayValidationError('Relay request body is not valid JSON for this route', 400);
  }
  if (!headers) {
    throw relayValidationError('Relay request includes an unsafe header override', 400);
  }
  return { method, targetPath, headers };
}

export class WsRelayService {
  private wss: any;
  private sessionSeq = 0;
  private currentSession: WsRelaySessionStats | null = null;
  private readonly securityConfig: RelaySecurityConfig;

  constructor(private app: FastifyInstance) {
    this.securityConfig = getRelaySecurityConfig();
    const ServerCtor = WS.Server || WS.WebSocketServer;
    this.wss = new ServerCtor({ noServer: true });
    this.attachUpgradeHandler();
  }

  private attachUpgradeHandler() {
    this.app.server.on('upgrade', (req, socket, head) => {
      const url = this.safeParseUrl(req);
      if (!url || !/^\/ws(?:\/|$)/.test(url.pathname)) return;

      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (!isRelayOriginAllowed(origin, req.headers.host, this.securityConfig.allowedOrigins)) {
        this.rejectUpgrade(socket, 403, 'WebSocket origin is not allowed');
        return;
      }

      if (this.securityConfig.authenticationRequired
        && !tokenMatches(this.securityConfig.token, relayTokenFromRequest(req, url))) {
        this.rejectUpgrade(socket, 401, 'WebSocket relay authentication required');
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, url.pathname, {
          authenticated: this.securityConfig.authenticationRequired,
          origin,
        });
      });
    });
  }

  private rejectUpgrade(socket: any, statusCode: number, message: string) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
    );
    socket.destroy();
  }

  private safeParseUrl(req: IncomingMessage): URL | null {
    try {
      const host = req.headers.host || 'localhost';
      return new URL(req.url || '/', `http://${host}`);
    } catch {
      return null;
    }
  }

  private handleConnection(ws: any, wsPathname: string, connection: { authenticated: boolean; origin?: string }) {
    const boundPath = normalizeRelayPath(wsPathname.replace(/^\/ws(?=\/|$)/, '')) || '/';
    const sessionId = `ws-${Date.now()}-${++this.sessionSeq}`;
    const session: WsRelaySessionStats = {
      sessionId,
      boundPath,
      connectedAt: new Date().toISOString(),
      active: true,
      authenticated: connection.authenticated,
      origin: connection.origin,
      receivedPackets: 0,
      repliedPackets: 0,
      failedPackets: 0,
    };
    this.currentSession = session;
    console.log(`[ws-relay ${sessionId}] connected boundPath=${boundPath}`);
    this.sendReply(ws, { event: 'connected', boundPath, sessionId });

    ws.on('message', async (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let payload: WsRelayRequest;
      if (session) {
        session.receivedPackets += 1;
        session.lastReceivedAt = new Date().toISOString();
      }

      try {
        const parsedPayload = JSON.parse(text);
        if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
          throw new Error('Invalid relay request payload');
        }
        payload = parsedPayload;
      } catch (error: any) {
        if (session) {
          session.failedPackets += 1;
          session.lastError = error?.message || 'Invalid JSON payload';
        }
        console.log(`[ws-relay ${session?.sessionId || 'unknown'}] invalid payload`);
        this.sendReply(ws, { ok: false, error: error?.message || 'Invalid JSON payload' });
        session.repliedPackets += 1;
        session.lastRepliedAt = new Date().toISOString();
        return;
      }

      const id = payload.id;
      try {
        const { method, targetPath, headers: forwardedHeaders } = validateRelayRequest(payload, boundPath);
        const targetUrl = targetPath;
        if (session) {
          session.lastMethod = method;
          session.lastTargetPath = targetUrl;
        }
        console.log(
          `[ws-relay ${session?.sessionId || 'unknown'}] received #${session?.receivedPackets || 0}`,
          {
            id,
            method,
            targetPath,
            query: payload.query || {},
            hasBody: !!payload.body,
          }
        );
        const response: any = await (this.app as any).inject({
          method,
          url: targetUrl,
          payload: payload.body,
          headers: {
            'content-type': 'application/json',
            'x-tradelayer-internal-relay': '1',
            ...forwardedHeaders,
          },
        });

        const bodyText = response.payload || '';
        let parsed: any = bodyText;
        try {
          parsed = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsed = bodyText;
        }

        const ok = response.statusCode < 400;
        const replyPayload = {
          id,
          ok,
          statusCode: response.statusCode,
          data: ok ? parsed : undefined,
          error: ok ? undefined : parsed?.error || parsed || 'Request failed',
        };
        if (session) {
          session.repliedPackets += 1;
          session.lastRepliedAt = new Date().toISOString();
          if (!ok) {
            session.failedPackets += 1;
            session.lastError = String((replyPayload as any).error || 'Request failed');
          }
        }
        console.log(
          `[ws-relay ${session?.sessionId || 'unknown'}] replied #${session?.repliedPackets || 0}`,
          {
            id,
            ok,
            statusCode: response.statusCode,
            error: ok ? undefined : (replyPayload as any).error,
          }
        );
        this.sendReply(ws, replyPayload);
      } catch (error: any) {
        if (session) {
          session.failedPackets += 1;
          session.lastError = error?.message || 'Internal WS relay error';
        }
        console.log(`[ws-relay ${session?.sessionId || 'unknown'}] error`, error?.message || error);
        this.sendReply(ws, {
          id,
          ok: false,
          statusCode: Number(error?.statusCode) || 500,
          error: error?.message || 'Internal WS relay error',
        });
        session.repliedPackets += 1;
        session.lastRepliedAt = new Date().toISOString();
      }
    });

    ws.on('close', () => {
      if (session.sessionId === sessionId) {
        session.active = false;
      }
      console.log(`[ws-relay ${sessionId}] closed`, session);
    });
  }

  private sendReply(ws: any, payload: Record<string, unknown>) {
    ws.send(JSON.stringify(payload));
  }

  status() {
    return this.currentSession
      ? {
          ...this.currentSession,
        }
      : {
          sessionId: null,
          boundPath: null,
          connectedAt: null,
          active: false,
          authenticated: false,
          receivedPackets: 0,
          repliedPackets: 0,
          failedPackets: 0,
        };
  }
}
