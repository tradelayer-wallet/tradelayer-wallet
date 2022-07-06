import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";

export class SocketService {
    public io: Server;
    public currentSocket: Socket;

    constructor() {}

    init(app: FastifyInstance) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(app.server, socketOptions);
        this.handleEvents()
    }

    private handleEvents() {
        this.io.on('connection', this.onConnection.bind(this));
    }

    private onConnection(socket: Socket) {
        if (this.currentSocket) this.currentSocket.offAny()
        this.currentSocket = socket;
    }
}