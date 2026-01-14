// position.service.ts

import { Injectable, OnDestroy } from '@angular/core';
import { Observable, forkJoin, of, timer, Subscription } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TlApiService } from 'src/app/@core/services/tl-api.service';

type DecodedTx = any;

type TlMempoolMeaning = {
  ok: boolean;
  contractId: number;
  contracts: number;
  buyerAddress: string;
  sellerAddress: string;
};

export interface IPosition {
    "entry_price": string;
    "position": string;
    "BANKRUPTCY_PRICE": string;
    "position_margin": string;
    "upnl": string;
}


@Injectable({ providedIn: 'root' })
export class FuturesPositionService implements OnDestroy {
  private txCache = new Map<string, { at: number; tx: DecodedTx }>();
  private pollSub?: Subscription;

  pendingPositionDeltaByContract: Record<number, number> = {};
  pendingUpnlDeltaByContract: Record<number, number> = {};

  constructor(
    private rpc: RpcService,
    private tlApi: TlApiService
  ) {}

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------
  onInit(address: string, contractId: number) {
    this.pollSub?.unsubscribe();

    this.pollSub = this.mempoolContractsDelta$(
      address,
      contractId
    ).subscribe(delta => {
      if (delta === 0) {
        delete this.pendingPositionDeltaByContract[contractId];
      } else {
        this.pendingPositionDeltaByContract[contractId] = delta;
      }
    });
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // mempool poller
  // ---------------------------------------------------------------------------
  mempoolContractsDelta$(
    address: string,
    contractId: number,
    pollMs = 1500,
    maxTx = 80,
    cacheMs = 8000
  ): Observable<number> {
    return timer(0, pollMs).pipe(
      switchMap(() => this.getMempoolVerbose$()),
      switchMap(mempoolVerbose => {
        const txids = this.pickTxids(mempoolVerbose, maxTx);
        if (!txids.length) return of(0);

        return this.fetchTlCandidates$(txids, contractId, cacheMs).pipe(
          switchMap(tlCandidates => {
            if (!tlCandidates.length) return of(0);

            const meaning$ = tlCandidates.map(c =>
              this.tlApi.checkValidMempoolTx$(c.txid, c.payloadUtf8).pipe(
                catchError(() => of({ ok: false } as any))
              )
            );

            return forkJoin(meaning$ as Observable<TlMempoolMeaning>[]).pipe(
                map(meanings => {
                let delta = 0;
                for (const m of meanings) {
                  if (!m?.ok) continue;
                  if (m.contractId !== contractId) continue;
                  delta += this.signedDeltaForAddress(m, address);
                }
                return delta;
              })
            );
          }),
          catchError(() => of(0))
        );
      }),
      catchError(() => of(0))
    );
  }

  // ---------------------------------------------------------------------------
  // core rpc
  // ---------------------------------------------------------------------------
  private getMempoolVerbose$(): Observable<any> {
    return this.rpc.rpc('getrawmempool', [true]) as any;
  }

  private getRawTransactionDecoded$(txid: string): Observable<DecodedTx> {
    return this.rpc.rpc('getrawtransaction', [txid, true]) as any;
  }

  // ---------------------------------------------------------------------------
  // candidate extraction
  // ---------------------------------------------------------------------------
  private fetchTlCandidates$(
    txids: string[],
    contractId: number,
    cacheMs: number
  ): Observable<Array<{ txid: string; payloadUtf8: string }>> {
    const reqs = txids.map(txid =>
      this.getDecodedCached$(txid, cacheMs).pipe(
        map(decoded => {
          const payloads = this.extractTlPayloadsFromDecodedTx(decoded);
          const matching = payloads.filter(p => {
            const hdr = this.parseTlHeader(p);
            return !!hdr && hdr.contractId === contractId;
          });
          return matching.map(payloadUtf8 => ({ txid, payloadUtf8 }));
        }),
        catchError(() => of([]))
      )
    );

    return forkJoin(reqs).pipe(
      map(lists => lists.reduce((a, b) => a.concat(b), []))
    );
  }

  private getDecodedCached$(txid: string, cacheMs: number): Observable<DecodedTx> {
    const now = Date.now();
    const hit = this.txCache.get(txid);
    if (hit && now - hit.at <= cacheMs) return of(hit.tx);

    return this.getRawTransactionDecoded$(txid).pipe(
      map(tx => {
        this.txCache.set(txid, { at: now, tx });
        if (this.txCache.size > 300) {
          for (const [k, v] of this.txCache) {
            if (now - v.at > cacheMs) this.txCache.delete(k);
          }
        }
        return tx;
      })
    );
  }

  private pickTxids(mempoolVerbose: any, maxTx: number): string[] {
    if (!mempoolVerbose) return [];

    if (typeof mempoolVerbose === 'object' && !Array.isArray(mempoolVerbose)) {
      const txids = Object.keys(mempoolVerbose);
      txids.sort((a, b) => {
        const ta = Number(mempoolVerbose[a]?.time ?? 0);
        const tb = Number(mempoolVerbose[b]?.time ?? 0);
        return tb - ta;
      });
      return txids.slice(0, maxTx);
    }

    if (Array.isArray(mempoolVerbose)) {
      return mempoolVerbose.slice(0, maxTx);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // tl parsing helpers
  // ---------------------------------------------------------------------------
  private extractTlPayloadsFromDecodedTx(decoded: any): string[] {
    const out: string[] = [];
    const vouts = decoded?.vout || [];
    for (const v of vouts) {
      const asm: string = v?.scriptPubKey?.asm || '';
      if (!asm.startsWith('OP_RETURN')) continue;
      const parts = asm.split(' ');
      if (parts.length < 2) continue;
      try {
        const s = Buffer.from(parts[1], 'hex').toString('utf8');
        if (s?.startsWith('tl')) out.push(s);
      } catch {}
    }
    return out;
  }

  private parseTlHeader(payload: string): { channel: string; contractId: number } | null {
    const comma = payload.indexOf(',');
    if (!payload.startsWith('tl') || comma === -1) return null;

    const channel = payload[2];
    const contractId = parseInt(payload.slice(3, comma), 36);
    if (!Number.isFinite(contractId)) return null;

    return { channel, contractId };
  }

  private signedDeltaForAddress(m: TlMempoolMeaning, address: string): number {
    if (m.buyerAddress === address) return +m.contracts;
    if (m.sellerAddress === address) return -m.contracts;
    return 0;
  }
}
