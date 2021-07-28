import { Socket } from "socket.io";
import { TClient } from "../common/types";
import { Listener } from "./listener";

export class ListenerServer {
    private io: any;
    private port: number;
    private address: string;
    private pubkey: string;
    private client: TClient;
    private logs: boolean;

    constructor(address: string, port: number, client: TClient, logs: boolean) {
        this.port = port
        this.address = address;
        this.client = client;
        this.logs = logs;
        this.validateAddress();
    }

  close(): void {
    this.io.close();
  }

  private async validateAddress() {
    const vaRes = await this.client("validateaddress", this.address);
    const { error, data } = vaRes;
    if (!error && data?.isvalid) {
        if (!data.ismine) {
            console.log(`You dont have access to address: ${this.address}`);
        } else {
            this.pubkey = data.pubkey;
            this.init();
        }
    } else {
        console.log(`Not valid address: ${this.address}`);
    }
  }

  private init(): void {
    const io = require('scoket.io');
    this.io = io(this.port);
    console.log(`Start Listener Server on port ${this.port}`);
    this.io.on("connection", this.onConnection.bind(this));
  }

  private onConnection(socket: Socket): void {
    new Listener(socket, this.address, this.pubkey, this.client, this.logs);
  }
}