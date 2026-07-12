import { AfterViewInit, Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ExplorerApiService } from 'src/app/@core/apis/explorer-api.service';

type BitvmContractRow = {
  contractId: string;
  templateId: string;
  chain: string;
  fundingTxid: string;
  depositSats: string;
  withdrawnSats: string;
  rolloverSats: string;
  settlementKind: string;
  route: string;
  maturityHeight: string;
  rollLocktime: string;
  challengeStart: string;
  challengeEnd: string;
  expiryHeight: string;
  blocksToRoll: string;
};

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
  contractRows: BitvmContractRow[] = [];
  contractLedger: any = null;
  depositedContractCount = 0;
  withdrawnContractCount = 0;
  totalDepositedSats = '0';
  totalWithdrawnSats = '0';
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
        this.loadContractLedger(res);
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  private loadContractLedger(fallbackOverview: any) {
    this.explorerApi.bitvmContracts().subscribe({
      next: (ledger) => {
        this.applyContractLedger(ledger, fallbackOverview);
        this.loading = false;
        this.renderGraph();
      },
      error: () => {
        this.applyContractLedger(null, fallbackOverview);
        this.loading = false;
        this.renderGraph();
      }
    });
  }

  private applyContractLedger(ledger: any, fallbackOverview: any) {
    this.contractLedger = ledger || null;
    this.contractRows = Array.isArray(ledger?.contracts) ? ledger.contracts : this.buildContractRows(fallbackOverview);
    this.depositedContractCount = Number(ledger?.depositedContractCount ?? NaN);
    if (!Number.isFinite(this.depositedContractCount)) {
      this.depositedContractCount = this.contractRows.filter((row) => Number(row.depositSats || 0) > 0).length;
    }
    this.withdrawnContractCount = Number(ledger?.withdrawnContractCount ?? NaN);
    if (!Number.isFinite(this.withdrawnContractCount)) {
      this.withdrawnContractCount = this.contractRows.filter((row) => Number(row.withdrawnSats || 0) > 0).length;
    }
    this.totalDepositedSats = String(ledger?.totalDepositedSats ?? this.sumField(this.contractRows, 'depositSats'));
    this.totalWithdrawnSats = String(ledger?.totalWithdrawnSats ?? this.sumField(this.contractRows, 'withdrawnSats'));
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
    push('winnerAddr', artifact.routingCommitments?.winnerAddress, 14);
    push('refundAddr', artifact.routingCommitments?.refundAddress, 14);

    return parts.length ? parts.join(' | ') : 'available';
  }

  private buildContractRows(overview: any): BitvmContractRow[] {
    const artifacts = overview?.artifacts || {};
    const draft = artifacts.draft || {};
    const finalized = artifacts.finalized || {};
    const rollForward = artifacts.rollForward || {};
    const challengeBundle = artifacts.challengeBundle || {};
    const expiryRedemption = artifacts.expiryRedemption || {};
    const contract = draft.contract || {};
    const settlement = expiryRedemption.settlementBreakdown || expiryRedemption.deltas?.settlementBreakdown || {};
    const witness = expiryRedemption.witnessBlob?.committed || {};
    const currentEpoch = rollForward.currentEpoch || {};
    const fundingInputs = Array.isArray(contract.fundingInputs) ? contract.fundingInputs : [];
    const currentBlock = Number(overview?.chainInfo?.blocks || expiryRedemption.chain?.height || 0);
    const rollLocktime = this.valueOr(currentEpoch.rollLocktime, contract.refundLocktime, challengeBundle.selectedPath?.locktime);
    const blocksToRollNum = Number(rollLocktime || 0) - currentBlock;

    const row: BitvmContractRow = {
      contractId: this.valueOr(contract.eventId, currentEpoch.contractId, overview?.bitvm?.contractId, 'current-bitvm-contract'),
      templateId: this.valueOr(draft.template?.templateId, overview?.bitvm?.template?.templateId, 'n/a'),
      chain: this.valueOr(draft.chain?.chainId, finalized.chain?.chainId, overview?.chainInfo?.chain, 'unknown'),
      fundingTxid: this.valueOr(finalized.txid, currentEpoch.fundingTxid, expiryRedemption.deposit?.txid, 'n/a'),
      depositSats: this.valueOr(expiryRedemption.deposit?.amountSats, contract.collateralSats, this.sumFundingInputs(fundingInputs), '0'),
      withdrawnSats: this.valueOr(expiryRedemption.redemption?.amountSats, settlement.redeemedSats, '0'),
      rolloverSats: this.valueOr(currentEpoch.rolloverCollateralSats, settlement.rolloverCollateralSats, '0'),
      settlementKind: this.valueOr(expiryRedemption.redemption?.settlementKind, settlement.settlementKind, 'pending'),
      route: this.valueOr(settlement.route, currentEpoch.defaultAction, challengeBundle.selectedPathId, 'n/a'),
      maturityHeight: this.valueOr(contract.maturityHeight, expiryRedemption.deltas?.maturityHeight, 'n/a'),
      rollLocktime: this.valueOr(rollLocktime, 'n/a'),
      challengeStart: this.valueOr(witness.challengeWindowStart, expiryRedemption.deltas?.maturityHeight, 'n/a'),
      challengeEnd: this.valueOr(witness.challengeWindowEnd, 'n/a'),
      expiryHeight: this.valueOr(expiryRedemption.deltas?.expiryHeight, expiryRedemption.chain?.height, 'n/a'),
      blocksToRoll: Number.isFinite(blocksToRollNum) ? String(Math.max(0, blocksToRollNum)) : 'n/a'
    };

    const hasContractSignal = row.contractId !== 'current-bitvm-contract'
      || row.fundingTxid !== 'n/a'
      || Number(row.depositSats || 0) > 0
      || Number(row.withdrawnSats || 0) > 0;

    return hasContractSignal ? [row] : [];
  }

  private valueOr(...values: any[]): string {
    const found = values.find((value) => value !== null && value !== undefined && value !== '');
    return String(found ?? 'n/a');
  }

  private sumFundingInputs(inputs: any[]): string {
    const total = inputs.reduce((sum, input) => sum + Number(input?.amountSats || 0), 0);
    return Number.isFinite(total) ? String(total) : '0';
  }

  private sumField(rows: BitvmContractRow[], field: 'depositSats' | 'withdrawnSats'): string {
    const total = rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
    return Number.isFinite(total) ? String(total) : '0';
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
