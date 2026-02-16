import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { CollatorManifestV1 } from 'src/p2p/manifest';
import { manifestUrlFromWs, verifyManifest } from 'src/p2p/manifest';

export interface CollatorManifestFetchResult {
  url: string;
  manifestUrl: string;
  manifest?: CollatorManifestV1;
  verified: boolean;
  reason?: string;
}

@Injectable({ providedIn: 'root' })
export class CollatorManifestService {
  constructor(private http: HttpClient) {}

  async fetch(wsUrl: string): Promise<CollatorManifestFetchResult> {
    const manifestUrl = manifestUrlFromWs(wsUrl);
    try {
      const m = await this.http.get<CollatorManifestV1>(manifestUrl).toPromise();
      const v = verifyManifest(m);
      return { url: wsUrl, manifestUrl, manifest: m, verified: v.ok, reason: v.reason };
    } catch (e: any) {
      return { url: wsUrl, manifestUrl, verified: false, reason: e?.message || String(e) };
    }
  }
}
