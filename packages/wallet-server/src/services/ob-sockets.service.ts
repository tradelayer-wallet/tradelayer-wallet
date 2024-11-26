// services/ob-sockets.service.ts

import { Websocket } from 'hyper-express';
import { fasitfyServer } from '..'; // Adjust the import path as necessary

// Define necessary interfaces
interface ITradeInfo {
    buyer: { socketId: string };
    seller: { socketId: string };
    // Add other relevant fields
}

interface IResultChannelSwap {
    data?: { txid: string };
    error?: string;
    socketId?: string;
}

interface TOrder {
    orderId: string;
    // Add other relevant fields
}

interface IMessage {
    event: string;
    data: any;
}

export interface IOBSocketServiceOptions {
    url: string;
}

const eventPrefix = 'OB_SOCKET';

const EVENTS = {
    ORDER_ERROR: 'order:error',
    ORDER_SAVED: 'order:saved',
    PLACED_ORDERS: 'placed-orders',
    ORDERBOOK_DATA: 'orderbook-data',
    UPDATE_ORDERS_REQUEST: 'update-orders-request',
    NEW_CHANNEL: 'new-channel',
    SWAP: 'swap',
} as const;

type EventKeys = keyof typeof EVENTS;

// Adjust sendEvent to accept only defined event keys
private sendEvent(event: EventKeys, data: any) {
    this.socket.send(JSON.stringify({ event, data }));
}

export class OBSocketService {
    public socket: Websocket;

    constructor(
        private options: IOBSocketServiceOptions,
    ) {
        // Initialize WebSocket connection to the wallet
        this.socket = new Websocket(this.options.url);

        // Set up core WebSocket event handlers
        ['open', 'close', 'error'].forEach(event => {
            this.socket.on(event, () => {
                if (event === 'open') this.handleOpen();
                const fullEventName = `${eventPrefix}::${event}`;
                this.sendEvent(fullEventName as EventKeys, {});
            });
        });

        // Set up custom event handlers
        this.initializeCustomEventHandlers();
    }

    // Reference to the main wallet WebSocket connection
    get walletSocket(): Websocket {
        return fasitfyServer.mainSocketService.currentSocket;
    }

    private handleOpen() {
        console.log('WebSocket connection to wallet opened.');
        // Perform any initialization upon connection open
    }

    private initializeCustomEventHandlers() {
        // Listen for incoming messages and handle based on 'event' field
        this.socket.on('message', (data: string | ArrayBuffer) => {
            try {
                const message = typeof data === 'string' ? data : data.toString();
                const parsedData = JSON.parse(message) as IMessage;

                if (!parsedData.event) {
                    console.warn('Received message without event:', parsedData);
                    return;
                }

                switch (parsedData.event) {
                    case EVENTS.ORDER_ERROR:
                        this.handleOrderError(parsedData.data);
                        break;
                    case EVENTS.ORDER_SAVED:
                        this.handleOrderSaved(parsedData.data);
                        break;
                    case EVENTS.PLACED_ORDERS:
                        this.handlePlacedOrders(parsedData.data);
                        break;
                    case EVENTS.ORDERBOOK_DATA:
                        this.handleOrderbookData(parsedData.data);
                        break;
                    case EVENTS.UPDATE_ORDERS_REQUEST:
                        this.handleUpdateOrdersRequest(parsedData.data);
                        break;
                    case EVENTS.NEW_CHANNEL:
                        this.handleNewChannel(parsedData.data);
                        break;
                    case EVENTS.SWAP:
                        this.handleSwap(parsedData.data);
                        break;
                    default:
                        console.warn('Unhandled event:', parsedData.event);
                        break;
                }

            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        // Handle messages from wallet to server
        ["update-orderbook", "new-order", "close-order", 'many-orders'].forEach(eventName => {
            this.walletSocket.on(eventName, (data: any) => {
                // Ensure the event name is one of the predefined events
                if ((EVENTS as any)[eventName]) {
                    this.sendEvent(eventName as EventKeys, data);
                } else {
                    console.warn(`Attempted to send undefined event: ${eventName}`);
                }
            });
        });
    }

    private sendEvent(event: EventKeys, data: any) {
        this.socket.send(JSON.stringify({ event, data }));
    }

    private handleOrderError(data: any) {
        console.error('Order Error:', data.message);
        // Implement additional logic here, e.g., notify clients, log, etc.
    }

    private handleOrderSaved(data: any) {
        console.log('Order Saved:', data.orderId);
        // Implement additional logic here, e.g., update database, notify clients, etc.
    }

    private handlePlacedOrders(data: any) {
        console.log('Placed Orders:', data);
        // Implement additional logic here
    }

    private handleOrderbookData(data: any) {
        console.log('Orderbook Data:', data);
        // Implement additional logic here
    }

    private handleUpdateOrdersRequest(data: any) {
        console.log('Update Orders Request:', data);
        // Implement additional logic here
    }

    private handleNewChannel(data: any) {
        console.log('New Channel:', data);
        // Implement logic to handle a new channel
        // Example: Initialize a swap process or notify relevant parties
    }

    private handleSwap(data: any) {
        console.log('Swap Event:', data);
        // Implement swap handling logic
        // Example: Validate swap data, initiate transactions, notify clients, etc.
    }
}
