import { Injectable } from "@angular/core";
import { CollatorApiService, CollatorStartRequest, CollatorStatus } from "../apis/collator-api.service";

@Injectable({ providedIn: 'root' })
export class CollatorHostService {
  constructor(private api: CollatorApiService) {}

  async status(): Promise<CollatorStatus> {
    const res = await this.api.status().toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }

  async start(req: CollatorStartRequest): Promise<CollatorStatus> {
    const res = await this.api.start(req).toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }

  async stop(): Promise<CollatorStatus> {
    const res = await this.api.stop().toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }
}
