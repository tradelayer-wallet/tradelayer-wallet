import { Injectable } from "@angular/core";
import {
  RustSequencerApiService,
  RustSequencerStartRequest,
  RustSequencerStatus,
} from "../apis/rust-sequencer-api.service";

@Injectable({ providedIn: 'root' })
export class RustSequencerHostService {
  constructor(private api: RustSequencerApiService) {}

  async status(): Promise<RustSequencerStatus> {
    const res = await this.api.status().toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }

  async start(req: RustSequencerStartRequest): Promise<RustSequencerStatus> {
    const res = await this.api.start(req).toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }

  async stop(): Promise<RustSequencerStatus> {
    const res = await this.api.stop().toPromise();
    if (res.error) throw new Error(res.error);
    return res.data || { running: false };
  }
}
