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
