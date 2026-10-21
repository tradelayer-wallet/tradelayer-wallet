import { Injectable } from "@angular/core";
import { OrderLedger } from "src/app/utils/swapper/order-ledger";

// The wallet's one record of the spot orders it placed and how much of each is open (utils/swapper/
// order-ledger.ts). SpotOrdersService records into it; SwapService starts a swap only for a trade it fits.
@Injectable({
    providedIn: 'root',
})
export class OrderLedgerService extends OrderLedger {}
