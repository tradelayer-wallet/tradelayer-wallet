import { Component, OnInit } from '@angular/core';
import { ExplorerApiService } from 'src/app/@core/apis/explorer-api.service';

@Component({
  selector: 'tl-bitvm-page',
  templateUrl: './bitvm-page.component.html',
  styleUrls: ['./bitvm-page.component.scss']
})
export class BitvmPageComponent implements OnInit {
  overview: any = null;
  report: any = null;
  addressQuery = '';
  propertyQuery = '';
  txQuery = '';
  lookupResult: any = null;
  loading = false;

  constructor(private explorerApi: ExplorerApiService) {}

  ngOnInit(): void {
    this.refresh();
  }

  refresh() {
    this.loading = true;
    this.explorerApi.overview().subscribe({
      next: (res) => {
        this.overview = res;
        this.report = res?.bitvm || null;
        this.loading = false;
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
}
