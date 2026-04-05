import { AfterViewInit, Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ExplorerApiService } from 'src/app/@core/apis/explorer-api.service';

@Component({
  selector: 'tl-bitvm-page',
  templateUrl: './bitvm-page.component.html',
  styleUrls: ['./bitvm-page.component.scss']
})
export class BitvmPageComponent implements OnInit, AfterViewInit {
  overview: any = null;
  report: any = null;
  artifactIndex: any[] = [];
  latestArtifacts: Array<{ name: string; label: string; artifact: any; summary: string }> = [];
  addressQuery = '';
  propertyQuery = '';
  txQuery = '';
  contractQuery = '';
  lookupResult: any = null;
  loading = false;
  private mermaidLoading?: Promise<void>;

  @ViewChild('graphHost') graphHost?: ElementRef<HTMLDivElement>;

  constructor(private explorerApi: ExplorerApiService) {}

  ngOnInit(): void {
    this.refresh();
  }

  ngAfterViewInit(): void {
    this.renderGraph();
  }

  refresh() {
    this.loading = true;
    this.explorerApi.overview().subscribe({
      next: (res) => {
        this.overview = res;
        this.report = res?.bitvm || null;
        this.artifactIndex = Array.isArray(res?.artifacts?.index) ? res.artifacts.index : [];
        this.latestArtifacts = this.buildLatestArtifacts(res?.artifacts || {});
        this.loading = false;
        this.renderGraph();
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  inspectAddress() {
    if (!this.addressQuery.trim()) return;
    this.explorerApi.address(this.addressQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  inspectProperty() {
    if (!this.propertyQuery.trim()) return;
    this.explorerApi.property(this.propertyQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  inspectTx() {
    if (!this.txQuery.trim()) return;
    this.explorerApi.tx(this.txQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  decodeBitvmTx() {
    if (!this.txQuery.trim()) return;
    this.explorerApi.decodeBitvmTx(this.txQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  inspectAddressHistory() {
    if (!this.addressQuery.trim()) return;
    this.explorerApi.addressHistory(this.addressQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  inspectContractHistory() {
    if (!this.contractQuery.trim()) return;
    this.explorerApi.contractHistory(this.contractQuery.trim()).subscribe((res) => this.lookupResult = res);
  }

  inspectArtifact(name: string) {
    if (!name.trim()) return;
    this.explorerApi.artifact(name.trim()).subscribe((res) => this.lookupResult = res);
  }

  private buildLatestArtifacts(artifacts: any) {
    const entries = [
      { name: 'm1_dlc_draft_latest.json', label: 'Draft', artifact: artifacts?.draft },
      { name: 'm1_funding_psbt_latest.json', label: 'Funding PSBT', artifact: artifacts?.funding },
      { name: 'm1_funding_finalized_latest.json', label: 'Finalized funding', artifact: artifacts?.finalized },
      { name: 'm1_roll_forward_latest.json', label: 'Roll forward', artifact: artifacts?.rollForward },
      { name: 'm1_challenge_bundle_latest.json', label: 'Challenge bundle', artifact: artifacts?.challengeBundle },
      { name: 'm1_challenge_witness_latest.json', label: 'Challenge witness', artifact: artifacts?.challengeWitness },
      { name: 'm1_expiry_redemption_latest.json', label: 'Expiry redemption', artifact: artifacts?.expiryRedemption }
    ];

    return entries.map((entry) => ({
      ...entry,
      summary: this.summarizeArtifact(entry.artifact)
    }));
  }

  private summarizeArtifact(artifact: any) {
    if (!artifact) {
      return 'missing';
    }

    const parts: string[] = [];
    const push = (label: string, value: any, limit = 16) => {
      if (value === null || value === undefined || value === '') return;
      const text = String(value);
      parts.push(`${label}: ${text.length > limit ? `${text.slice(0, limit)}…` : text}`);
    };

    push('kind', artifact.kind);
    push('route', artifact.route);
    push('path', artifact.pathId);
    push('tx', artifact.txid);
    push('hash', artifact.artifactHash);
    push('bundle', artifact.sourceChallengeBundleHash);
    push('redeemed', artifact.redemption?.amountSats);
    push('pnl', artifact.deltas?.netDeltaSats);
    push('loss', artifact.deltas?.pnlLossSats);
    push('gain', artifact.deltas?.pnlGainSats);
    push('winnerSweep', artifact.settlementBreakdown?.winnerSweepSats || artifact.deltas?.settlementBreakdown?.winnerSweepSats);
    push('refund', artifact.settlementBreakdown?.refundSats || artifact.deltas?.settlementBreakdown?.refundSats);
    push('dust', artifact.settlementBreakdown?.dustCarrySats || artifact.deltas?.settlementBreakdown?.dustCarrySats);

    return parts.length ? parts.join(' · ') : 'available';
  }

  settlementKind(artifact: any): string {
    return String(
      artifact?.settlementBreakdown?.settlementKind
      || artifact?.deltas?.settlementBreakdown?.settlementKind
      || 'unknown'
    );
  }

  settlementChipClass(artifact: any): string {
    const kind = this.settlementKind(artifact).toLowerCase();
    if (kind.includes('timeout')) return 'timeout';
    if (kind.includes('branch') || kind.includes('pnl')) return 'branch';
    return 'unknown';
  }

  private async ensureMermaid() {
    const g = window as any;
    if (g.mermaid) {
      return;
    }

    if (!this.mermaidLoading) {
      this.mermaidLoading = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load mermaid'));
        document.head.appendChild(script);
      });
    }

    await this.mermaidLoading;
  }

  private async renderGraph() {
    const host = this.graphHost?.nativeElement;
    if (!host) return;

    const mermaidText = this.overview?.bitvm?.flow?.mermaid || 'graph TD\n  empty[No BitVM report found]';
    host.innerHTML = '';

    const node = document.createElement('div');
    node.className = 'mermaid';
    node.textContent = mermaidText;
    host.appendChild(node);

    try {
      await this.ensureMermaid();
      const g = window as any;
      if (g.mermaid) {
        g.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        if (typeof g.mermaid.run === 'function') {
          await g.mermaid.run({ nodes: [node] });
        } else if (typeof g.mermaid.init === 'function') {
          g.mermaid.init(undefined, node);
        }
      }
    } catch (error) {
      host.innerHTML = '<pre class="graph-fallback">' + mermaidText.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
      console.warn(error);
    }
  }
}
