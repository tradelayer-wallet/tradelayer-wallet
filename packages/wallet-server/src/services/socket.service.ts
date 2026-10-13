import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";
import { IncomingMessage } from "http";
import { fasitfyServer } from "..";
import { authTokensMatch, isLoopbackHostHeader } from "../utils/auth.util";

// Origins accepted on socket.io requests (see issue #45, C2). Electron loads
// the wallet UI from file:// and its WebSocket upgrades carry `Origin: file://`
// (checked against Electron 13.6.9); its XHR and fetch requests carry no Origin
// header. `null` (opaque origin) is also accepted, as before. Loopback http(s)
// origins are accepted for development. Any other origin, including every
// remote website, is rejected. Host is checked separately, and the token is
// still required for every socket.io connection.
const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const isAllowedSocketOrigin = (origin: string | undefined): boolean => {
    if (!origin || origin === 'null' || origin === 'file://') return true;
    return LOCAL_ORIGIN_REGEX.test(origin);
};

const isAllowedOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    callback(null, isAllowedSocketOrigin(origin));
};

// Host + Origin predicate for socket.io requests; used by the verify wrapper in init().
const isAllowedSocketRequest = (req: IncomingMessage): boolean =>
    isLoopbackHostHeader(req.headers?.host) && isAllowedSocketOrigin(req.headers?.origin);

export class SocketService {
    private blockCountingInterval: any;
    private lastBlock: number = 0;

    public io: Server;
    public currentSocket: Socket;

    constructor() {}

    init(app: FastifyInstance, authToken: string) {
        const socketOptions = {
            cors: { origin: isAllowedOrigin, methods: ["GET", "POST"] },
        };
        this.io = new Server(app.server, socketOptions);

        // Host + Origin enforcement for socket.io, in one place. engine.io
        // answers origin-form `/socket.io/` requests on the raw HTTP server
        // before any Fastify hook runs, so the check lives in engine.io's
        // `verify()`, which every engine.io request goes through: the handshake,
        // sid-bearing long-polls, and WebSocket upgrades. (engine.io's own
        // `allowRequest` option runs only for sid-less handshakes, so it is not
        // used.) Rejected requests get engine.io's FORBIDDEN code (4): HTTP 403
        // on polls and 400 on aborted upgrades.
        //
        // `engine.verify` is an engine.io internal. If it is missing we cannot
        // enforce the check, so startup fails instead of running without it.
        const engine = this.io.engine as unknown as {
            verify?: (req: IncomingMessage, upgrade: boolean, fn: (errorCode?: number, errorContext?: unknown) => void) => void;
        };
        if (typeof engine.verify !== 'function') {
            throw new Error('socket.io engine has no verify(): cannot enforce Host/Origin, refusing to start');
        }
        const verifyRequest = engine.verify.bind(engine);
        engine.verify = (req, upgrade, fn) => {
            if (!isAllowedSocketRequest(req)) {
                return fn(4, { message: 'Forbidden Host or Origin header' });
            }
            verifyRequest(req, upgrade, fn);
        };

        // Per-session token, read from `handshake.auth` only. A `query.token`
        // fallback is deliberately absent because query strings leak into URLs
        // and logs. (Host and Origin for this handshake were already checked by
        // the verify wrapper above.) See issue #45 (C1).
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token;
            if (authTokensMatch(token, authToken)) return next();
            next(new Error('unauthorized'));
        });
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
        if (this.currentSocket) this.currentSocket.offAny();
        this.currentSocket = socket;
    
        this.currentSocket.on('ob-sockets-connect', (url: string) => {
            fasitfyServer.initOBSocketConnection({ url });
        });

        this.currentSocket.on('ob-sockets-disconnect', () => {
            fasitfyServer.clearOBSocketConnection();
        });
    }

    startBlockCounting(ms: number) {
        if (this.blockCountingInterval) this.stopBlockCounting();
        const client = fasitfyServer.rpcClient;
        if (!client) return;
        this.blockCountingInterval = setInterval(async () => {
            const infoRes = await client.call('getblockchaininfo');
            if (infoRes.error || !infoRes.data) {
                if (infoRes.error && infoRes.error.includes('ECONNREFUSED')) {
                    const check = await client.call('getblockchaininfo');
                    if (check.error || !check.data) {
                        this.currentSocket.emit("core-error", check.error || 'Undefined Error. code 3')
                        this.stopBlockCounting();
                    }
                }
            }
            const height = infoRes?.data?.blocks;
            const header = infoRes?.data?.headers;
            if (height && this.lastBlock < height) {
                this.lastBlock = height;
                this.currentSocket.emit('new-block', { height, header });
            }
        }, ms);
    }

    stopBlockCounting() {
        if (this.lastBlock) this.lastBlock = 0;
        if (this.blockCountingInterval) clearInterval(this.blockCountingInterval);
    }
}