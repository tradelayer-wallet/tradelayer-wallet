// position.service.ts

import { Injectable } from '@angular/core';
import { Observable, forkJoin, of, timer } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { RpcService } from './rpc.service';
import { TlApiService } from './tl-api.service'; // <- your TL-aware service (decode/verify)

type DecodedTx = any;

type TlMempoolMeaning = {
  ok: boolean;
  contractId: number;
  contracts: number;
  buyerAddress: string;
  sellerAddress: string;
};

@Injectable({ providedIn: 'root' })
export class PositionService {
  // small cache so polling doesn't re-decode same tx every tick
  private txCache = new Map<string, { at: number; tx: DecodedTx }>();
  pendingPositionDeltaByContract: Record<number, number> = {};
  pendingUpnlDeltaByContract: Record<number, number> = {};


  constructor(
    private rpc: RpcService,
    private tlApi: TlApiService
  ) {}

  // ---------------------------------------------------------------------------
  // Public: poll mempool delta
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
          // tlCandidates = [{ txid, payloadUtf8 }]
          switchMap(tlCandidates => {
            if (!tlCandidates.length) return of(0);

            // For each candidate, ask TL API to decode/verify meaning (no state mutation)
            const meaning$ = tlCandidates.map(c =>
              this.tlApi.checkValidMempoolTx$(c.txid, c.payloadUtf8).pipe(
                catchError(() => of({ ok: false } as any))
              )
            );

            return forkJoin(meaning$).pipe(
              map((meanings: TlMempoolMeaning[]) => {
                let delta = 0;
                for (const m of meanings) {
                  if (!m?.ok) continue;
                  if (Number(m.contractId) !== Number(contractId)) continue;
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
  // Core RPC passthrough
  // ---------------------------------------------------------------------------
  private getMempoolVerbose$(): Observable<any> {
    // uses your RpcService.rpc(method, params)
    return this.rpc.rpc('getrawmempool', [true]) as any;
  }

  private getRawTransactionDecoded$(txid: string): Observable<DecodedTx> {
    return this.rpc.rpc('getrawtransaction', [txid, true]) as any;
  }

  // ---------------------------------------------------------------------------
  // Candidate extraction: mempool -> tx -> OP_RETURN TL payloads -> contract filter
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
          // filter by contractId quickly in FE (cheap)
          const matching = payloads.filter(p => {
            const hdr = this.parseTlHeader(p);
            return !!hdr && hdr.contractId === Number(contractId);
          });
          return matching.map(payloadUtf8 => ({ txid, payloadUtf8 }));
        }),
        catchError(() => of([]))
      )
    );

    return forkJoin(reqs).pipe(
      map((lists: Array<Array<{ txid: string; payloadUtf8: string }>>) => lists.flat())
    );
  }

  private getDecodedCached$(txid: string, cacheMs: number): Observable<DecodedTx> {
    const now = Date.now();
    const hit = this.txCache.get(txid);
    if (hit && (now - hit.at) <= cacheMs) return of(hit.tx);

    return this.getRawTransactionDecoded$(txid).pipe(
      map(tx => {
        this.txCache.set(txid, { at: now, tx });
        // light cache pruning
        if (this.txCache.size > 300) {
          for (const [k, v] of this.txCache) {
            if ((now - v.at) > cacheMs) this.txCache.delete(k);
          }
        }
        return tx;
      })
    );
  }

  private pickTxids(mempoolVerbose: any, maxTx: number): string[] {
    if (!mempoolVerbose) return [];

    // getrawmempool(true) usually returns an object keyed by txid
    if (typeof mempoolVerbose === 'object' && !Array.isArray(mempoolVerbose)) {
      const txids = Object.keys(mempoolVerbose);

      // optional: light prioritization by time (if present)
      txids.sort((a, b) => {
        const ta = Number(mempoolVerbose[a]?.time ?? 0);
        const tb = Number(mempoolVerbose[b]?.time ?? 0);
        return tb - ta;
      });

      return txids.slice(0, maxTx);
    }

    // some nodes return an array if verbose=false; handle anyway
    if (Array.isArray(mempoolVerbose)) {
      return mempoolVerbose.slice(0, maxTx);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // OP_RETURN TL parsing (same approach as BE)
  // ---------------------------------------------------------------------------
  private extractTlPayloadsFromDecodedTx(decoded: any): string[] {
    const out: string[] = [];
    const vouts = decoded?.vout || [];
    for (const v of vouts) {
      const asm: string = v?.scriptPubKey?.asm || '';
      if (!asm.startsWith('OP_RETURN')) continue;
      const parts = asm.split(' ');
      if (parts.length < 2) continue;
      const hex = parts[1];
      try {
        const s = Buffer.from(hex, 'hex').toString('utf8');
        if (s && s.startsWith('tl')) out.push(s);
      } catch {}
    }
    return out;
  }

  private parseTlHeader(payload: string): { channel: string; contractId: number } | null {
    if (!payload || payload.length < 4) return null;
    if (!payload.startsWith('tl')) return null;

    const comma = payload.indexOf(',');
    if (comma === -1) return null;

    const channel = payload[2];
    const contractIdPart = payload.slice(3, comma);
    const contractId = parseInt(contractIdPart, 36);
    if (!Number.isFinite(contractId)) return null;

    return { channel, contractId };
  }

  private signedDeltaForAddress(m: TlMempoolMeaning, address: string): number {
    const contracts = Number(m?.contracts ?? 0);
    if (!Number.isFinite(contracts) || contracts === 0) return 0;

    if (m.buyerAddress === address) return +contracts;
    if (m.sellerAddress === address) return -contracts;

    return 0;
  }
}
