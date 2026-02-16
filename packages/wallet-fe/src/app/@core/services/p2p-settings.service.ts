import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { ConnectivityMode } from 'src/p2p/policy/RoutingPolicy';

const LS_MODE = 'tl.connectivityMode';
const LS_COLLATORS = 'tl.collatorUrls';
const LS_REQUIRE_MANIFEST = 'tl.p2p.requireVerifiedManifest';
const LS_ALLOWED_COLLATOR_IDS = 'tl.p2p.allowedCollatorIds';
const LS_ENFORCE_CLEARLIST_SUBMITTER = 'tl.p2p.enforceClearlistSubmitter';
const LS_REQUIRE_INFRA_ATTEST = 'tl.p2p.requireInfraAttestation';
const LS_REQUIRED_CLEARLIST_ID = 'tl.p2p.requiredClearlistId';
const DEFAULT_COLLATORS = [
  'ws://127.0.0.1:8787/ws',
  'ws://127.0.0.1:8788/ws',
];

function readJson<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable({ providedIn: 'root' })
export class P2PSettingsService {
  private modeSub = new BehaviorSubject<ConnectivityMode>(
    (localStorage.getItem(LS_MODE) as ConnectivityMode) || 'CENTRAL'
  );
  private collatorUrlsSub = new BehaviorSubject<string[]>(
    readJson<string[]>(LS_COLLATORS, DEFAULT_COLLATORS)
  );
  private requireManifestSub = new BehaviorSubject<boolean>(
    localStorage.getItem(LS_REQUIRE_MANIFEST) === null
      ? true
      : localStorage.getItem(LS_REQUIRE_MANIFEST) === '1'
  );
  private allowedCollatorIdsSub = new BehaviorSubject<string[]>(
    readJson<string[]>(LS_ALLOWED_COLLATOR_IDS, [])
  );
  private enforceClearlistSubmitterSub = new BehaviorSubject<boolean>(
    localStorage.getItem(LS_ENFORCE_CLEARLIST_SUBMITTER) === '1'
  );
  private requireInfraAttestationSub = new BehaviorSubject<boolean>(
    localStorage.getItem(LS_REQUIRE_INFRA_ATTEST) === '1'
  );
  private requiredClearlistIdSub = new BehaviorSubject<string>(
    localStorage.getItem(LS_REQUIRED_CLEARLIST_ID) || ''
  );

  mode$ = this.modeSub.asObservable();
  collatorUrls$ = this.collatorUrlsSub.asObservable();
  requireVerifiedManifest$ = this.requireManifestSub.asObservable();
  allowedCollatorIds$ = this.allowedCollatorIdsSub.asObservable();
  enforceClearlistSubmitter$ = this.enforceClearlistSubmitterSub.asObservable();
  requireInfraAttestation$ = this.requireInfraAttestationSub.asObservable();
  requiredClearlistId$ = this.requiredClearlistIdSub.asObservable();

  get mode(): ConnectivityMode {
    return this.modeSub.value;
  }

  setMode(mode: ConnectivityMode) {
    localStorage.setItem(LS_MODE, mode);
    this.modeSub.next(mode);
  }

  get collatorUrls(): string[] {
    return this.collatorUrlsSub.value;
  }

  setCollatorUrls(urls: string[]) {
    const normalized = (urls || [])
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    localStorage.setItem(LS_COLLATORS, JSON.stringify(normalized));
    this.collatorUrlsSub.next(normalized);
  }

  get requireVerifiedManifest(): boolean {
    return !!this.requireManifestSub.value;
  }

  setRequireVerifiedManifest(v: boolean) {
    localStorage.setItem(LS_REQUIRE_MANIFEST, v ? '1' : '0');
    this.requireManifestSub.next(!!v);
  }

  get allowedCollatorIds(): string[] {
    return this.allowedCollatorIdsSub.value;
  }

  setAllowedCollatorIds(ids: string[]) {
    const normalized = (ids || [])
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    localStorage.setItem(LS_ALLOWED_COLLATOR_IDS, JSON.stringify(normalized));
    this.allowedCollatorIdsSub.next(normalized);
  }

  // Optional, MM-only hardening: require the SUBMITter to be clearlisted for CLEARLIST/DARK orders.
  // Default OFF to preserve the "retail can trade with clearlisted MM" model.
  get enforceClearlistSubmitter(): boolean {
    return !!this.enforceClearlistSubmitterSub.value;
  }

  setEnforceClearlistSubmitter(v: boolean) {
    localStorage.setItem(LS_ENFORCE_CLEARLIST_SUBMITTER, v ? '1' : '0');
    this.enforceClearlistSubmitterSub.next(!!v);
  }

  // Curated-mode gate: require a collator to present a valid InfraAttestationV1 signed by the protocol clearlist admin.
  // Default OFF (opt-in), since it requires an API server to fetch the clearlist admin address.
  get requireInfraAttestation(): boolean {
    return !!this.requireInfraAttestationSub.value;
  }

  setRequireInfraAttestation(v: boolean) {
    localStorage.setItem(LS_REQUIRE_INFRA_ATTEST, v ? '1' : '0');
    this.requireInfraAttestationSub.next(!!v);
  }

  // Clearlist registry ID (protocol-native) used to validate InfraAttestationV1 for collator acceptability.
  get requiredClearlistId(): string {
    return String(this.requiredClearlistIdSub.value || '');
  }

  setRequiredClearlistId(v: string) {
    const s = String(v || '').trim();
    localStorage.setItem(LS_REQUIRED_CLEARLIST_ID, s);
    this.requiredClearlistIdSub.next(s);
  }
}
