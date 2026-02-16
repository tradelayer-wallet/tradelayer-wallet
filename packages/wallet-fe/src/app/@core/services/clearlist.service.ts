import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ApiService } from './api.service';

export interface ClearlistCheckResult {
  allowed: boolean;
  snapshotId?: string;
  expTs?: number;
  pubkeyHex?: string;
}

export interface ClearlistAdminInfo {
  clearlistId: number;
  adminAddress: string | null;
  backupAddress?: string | null;
  name?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ClearlistService {
  private ttlMs = 60000;
  private cache = new Map<string, { exp: number; v: ClearlistCheckResult }>();
  private adminCache = new Map<number, { exp: number; v: ClearlistAdminInfo }>();

  constructor(private http: HttpClient, private api: ApiService) {}

  private key(groupId: string, pubkeyHex: string) {
    return `${groupId}|${pubkeyHex}`;
  }

  async check(groupId: string, pubkeyHex: string): Promise<ClearlistCheckResult> {
    const apiUrl = this.api.apiUrl;
    if (!apiUrl) throw new Error('No API server selected');
    const k = this.key(groupId, pubkeyHex);
    const now = Date.now();
    const hit = this.cache.get(k);
    if (hit && hit.exp > now) return hit.v;

    // Placeholder endpoint: POST <apiUrl>/clearlist/check { groupId, pubkeyHex }
    const url = `${apiUrl.replace(/\/+$/, '')}/clearlist/check`;
    const res: any = await this.http
      .post(
        url,
        { groupId, pubkeyHex, optIn: true },
        { headers: { 'X-TL-Clearlist-OptIn': '1' } }
      )
      .toPromise();

    const v: ClearlistCheckResult = {
      allowed: !!res?.allowed,
      snapshotId: res?.snapshotId ? String(res.snapshotId) : undefined,
      expTs: typeof res?.expTs === 'number' ? res.expTs : undefined,
      pubkeyHex,
    };
    this.cache.set(k, { exp: now + this.ttlMs, v });
    return v;
  }

  // Returns the first allowed result among the provided pubkeys (or {allowed:false}).
  async checkAny(groupId: string, pubkeysHex: string[]): Promise<ClearlistCheckResult> {
    const keys = (pubkeysHex || []).map((s) => String(s || '').trim()).filter(Boolean);
    for (const pk of keys) {
      const r = await this.check(groupId, pk);
      if (r.allowed) return r;
    }
    return { allowed: false };
  }

  async getAdmin(clearlistId: number): Promise<ClearlistAdminInfo> {
    const id = Number(clearlistId);
    if (!Number.isInteger(id) || id < 0) throw new Error('invalid clearlistId');
    const apiUrl = this.api.apiUrl;
    if (!apiUrl) throw new Error('No API server selected');

    const now = Date.now();
    const hit = this.adminCache.get(id);
    if (hit && hit.exp > now) return hit.v;

    const url = `${apiUrl.replace(/\/+$/, '')}/clearlist/admin/${id}`;
    const res: any = await this.http.get(url).toPromise();

    const v: ClearlistAdminInfo = {
      clearlistId: id,
      adminAddress: res?.adminAddress != null ? String(res.adminAddress) : null,
      backupAddress: res?.backupAddress != null ? String(res.backupAddress) : null,
      name: res?.name != null ? String(res.name) : null,
    };
    this.adminCache.set(id, { exp: now + this.ttlMs, v });
    return v;
  }
}
